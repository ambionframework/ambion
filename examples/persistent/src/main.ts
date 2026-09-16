/** One process owns all rooms. Clients keep their delivery keys and read cursors. */
import { access, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	type Room,
	resumeRoom,
	startRoom,
} from '@ambionframework/ambion';
import { type Sql, type SqlValue, sqliteJournals } from '@ambionframework/journal';

const [mode, directory = '.data'] = process.argv.slice(2);
if (mode !== 'start' && mode !== 'resume') throw new Error('Use start or resume [directory].');
const path = join(directory, 'rooms.db');
// Start refuses an existing directory. Resume refuses a missing database.
if (mode === 'start') await mkdir(directory);
else await access(path);
const database = new DatabaseSync(path);
const sql: Sql = {
	run(query, ...params) {
		database.prepare(query).run(...params);
	},
	all(query, ...params) {
		return database.prepare(query).all(...params) as Record<string, SqlValue>[];
	},
};
const runtime = createRuntime({ storage: sqliteJournals(sql) });
const agents = [
	defineAgent({
		name: 'guide',
		identity: 'Helps people make concrete plans.',
		instructions: 'Give a concise answer. Use the room goal and its conversation as context.',
		model: process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5',
	}),
];
const people = new Map(
	['alice', 'bob'].map((name) => [
		name,
		defineHuman({ name, identity: `${name}, project member.` }),
	]),
);
const rooms = new Map<string, Room>();
for (const [name, goal] of [
	['design', 'Plan the product design.'],
	['delivery', 'Plan the product release.'],
] as const) {
	const room =
		mode === 'start'
			? await startRoom({ name, goal, agents, runtime })
			: await resumeRoom(name, { agents, runtime });
	rooms.set(name, room);
	room.subscribe((event) => {
		if (event.type === 'error' || event.type === 'audit_error') {
			console.error(`[${name}] ${event.type}: ${event.error.message}`);
		}
	});
}

function reply(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 16_384) throw new SyntaxError('Request exceeds 16 KiB.');
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString());
}

function isDelivery(value: unknown): value is { key: string; text: string } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'key' in value &&
		typeof value.key === 'string' &&
		value.key.length > 0 &&
		'text' in value &&
		typeof value.text === 'string' &&
		value.text.trim().length > 0
	);
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
	const url = new URL(request.url ?? '/', 'http://localhost');
	if (request.method === 'GET' && url.pathname === '/rooms') {
		return reply(
			response,
			200,
			[...rooms.values()].map((room) => ({
				name: room.name,
				participants: room.participants(),
			})),
		);
	}
	const match = /^\/rooms\/([^/]+)\/(messages|exchanges|humans)(?:\/([^/]+))?$/.exec(url.pathname);
	const room = rooms.get(match?.[1] ?? '');
	if (!room || !match) return reply(response, 404, { error: 'Unknown route or room.' });
	const [, , resource, id] = match;
	if (request.method === 'GET') return read(room, resource, id, url, response);
	if (resource !== 'humans') return reply(response, 405, { error: 'Use GET.' });
	return write(room, id, request, response);
}

async function write(
	room: Room,
	id: string | undefined,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const person = people.get(id ?? '');
	if (!person) return reply(response, 404, { error: 'Unknown person.' });
	if (request.method === 'DELETE') {
		if (
			room
				.participants()
				.some(
					(seat) =>
						seat.name === person.name && seat.kind === 'human' && seat.presence === 'present',
				)
		) {
			await (await room.visit(person)).leave();
		}
		return reply(response, 200, { left: person.name });
	}
	if (request.method !== 'POST') return reply(response, 405, { error: 'Use POST or DELETE.' });
	const input = await body(request);
	if (!isDelivery(input)) return reply(response, 400, { error: 'Supply nonempty key and text.' });
	const visit = await room.visit(person);
	const exchange = await visit.send({ key: input.key, text: input.text });
	// Acceptance does not wait for model work. Other rooms and people remain available.
	reply(response, 202, { from: exchange.from, owner: exchange.owner });
}

async function read(
	room: Room,
	resource: string | undefined,
	id: string | undefined,
	url: URL,
	response: ServerResponse,
): Promise<void> {
	if (resource === 'messages' && id === undefined) {
		const since = Number(url.searchParams.get('since') ?? 0);
		if (!Number.isSafeInteger(since) || since < 0)
			return reply(response, 400, { error: 'Invalid cursor.' });
		return reply(response, 200, await room.messages({ since }));
	}
	const exchange = resource === 'exchanges' ? room.exchange(Number(id)) : undefined;
	if (!exchange) return reply(response, 404, { error: 'Unknown exchange.' });
	// This request waits for the discussion to close. It does not block other requests.
	reply(response, 200, await exchange.messages());
}

const server = createServer((request, response) => {
	void route(request, response).catch((error: unknown) => {
		reply(response, error instanceof SyntaxError ? 400 : 500, {
			error: error instanceof Error ? error.message : String(error),
		});
	});
});
server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
	const address = server.address();
	if (address && typeof address !== 'string') {
		console.log(`Rooms ready on http://127.0.0.1:${address.port}; PID ${process.pid}`);
	}
});

let closing = false;
async function stop(): Promise<void> {
	if (closing) return;
	closing = true;
	const closed = new Promise<void>((resolve) => server.close(() => resolve()));
	await Promise.all([...rooms.values()].map((room) => room.stop()));
	await closed;
	database.close();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
