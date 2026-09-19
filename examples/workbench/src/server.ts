import { access, mkdir, readFile as readLocalFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { CreateRuntimeOptions, HumanDefinition, Room } from '@ambionframework/ambion';
import { people } from './definitions.ts';
import { listFiles, readFile } from './files.ts';
import { fail, liveRoom, openRooms } from './rooms.ts';
import { scenarios } from './scenarios.ts';

const indexHtml = new URL('../ui/index.html', import.meta.url);
// The example serves the repository brand kit in the root `brand/` directory.
const brandDirectory = new URL('../../../brand/', import.meta.url);
const brandRoot = fileURLToPath(brandDirectory);
const brandTypes: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml; charset=utf-8',
	'.ttf': 'font/ttf',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
};

/** The browser and HTTP clients share the same application API. */
export async function openWorkbench(
	directory: string,
	mode: 'start' | 'resume',
	stream?: CreateRuntimeOptions['stream'],
) {
	const { database, rooms } = await openHost(directory, mode, stream);
	await createInitialRooms(rooms, database, mode);
	const server = createServer((request, response) => {
		void route(rooms, request, response).catch((error: unknown) => {
			const status = error instanceof SyntaxError ? 400 : errorStatus(error);
			reply(response, status, { error: error instanceof Error ? error.message : String(error) });
		});
	});

	let closing: Promise<void> | undefined;
	let closed: Promise<unknown> | undefined;
	return {
		server,
		close() {
			if (closing) return closing;
			const attempt = shutdown();
			closing = attempt.catch((error: unknown) => {
				closing = undefined;
				throw error;
			});
			return closing;
		},
	};
	async function shutdown() {
		let failure: unknown;
		const remember = (candidate: unknown): void => {
			if (failure === undefined && candidate !== undefined) failure = candidate;
		};
		closed ??= closeServer(server);
		remember(await captureFailure(() => rooms.close()));
		remember(await captureFailure(() => server.closeAllConnections()));
		remember(
			await captureFailure(async () => {
				const error = await closed;
				if (error !== undefined) throw error;
			}),
		);
		if (failure !== undefined) throw failure;
		await database.close();
	}
}

type Rooms = Awaited<ReturnType<typeof openRooms>>;

async function openHost(
	directory: string,
	mode: 'start' | 'resume',
	stream?: CreateRuntimeOptions['stream'],
): Promise<{ database: DatabaseSync; rooms: Rooms }> {
	const path = resolve(directory, 'rooms.db');
	if (mode === 'start') await mkdir(directory);
	else await access(path);
	const database = new DatabaseSync(path);
	try {
		return { database, rooms: await openRooms(database, directory, stream) };
	} catch (error) {
		try {
			database.close();
		} catch {
			// Preserve the startup failure that explains why the host could not open.
		}
		throw error;
	}
}

async function createInitialRooms(rooms: Rooms, database: DatabaseSync, mode: 'start' | 'resume') {
	if (mode !== 'start') return;
	try {
		for (const scenario of scenarios) await rooms.create(scenario.name, scenario.goal);
	} catch (error) {
		await captureFailure(() => rooms.close());
		await captureFailure(() => database.close());
		throw error;
	}
}

function closeServer(server: ReturnType<typeof createServer>): Promise<unknown> {
	return new Promise<unknown>((resolve) => {
		try {
			server.close((error) => resolve(error));
		} catch (error) {
			resolve(error);
		}
	});
}

async function captureFailure(operation: () => Promise<unknown> | unknown): Promise<unknown> {
	try {
		await operation();
		return undefined;
	} catch (error) {
		return error;
	}
}

async function route(
	rooms: Rooms,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	checkOrigin(request);
	const url = new URL(request.url ?? '/', 'http://localhost');
	if (request.method === 'GET' && (await staticRoute(url.pathname, response))) return;
	if (request.method === 'GET' && (await brandRoute(url.pathname, response))) return;
	if (request.method === 'GET' && (await workspaceRoute(rooms, url, response))) return;
	if (url.pathname === '/rooms') return collection(rooms, request, response);
	return roomRoute(rooms, request, response, url);
}

/** Serve the page and the people list. Return true when the path matched. */
async function staticRoute(pathname: string, response: ServerResponse): Promise<boolean> {
	switch (pathname) {
		case '/':
			await sendFile(response, indexHtml, 'text/html; charset=utf-8');
			return true;
		case '/people':
			reply(response, 200, people);
			return true;
		default:
			return false;
	}
}

/** Resolve a request path inside the brand directory. A malformed path is not an asset. */
function brandTarget(relative: string): string {
	try {
		return fileURLToPath(new URL(decodeURIComponent(relative), brandDirectory));
	} catch {
		return fail(404, 'Unknown brand asset.');
	}
}

/** Serve one file from the repository brand kit. Return true when handled. */
async function brandRoute(pathname: string, response: ServerResponse): Promise<boolean> {
	if (!pathname.startsWith('/brand/')) return false;
	const target = brandTarget(pathname.slice('/brand/'.length));
	if (!target.startsWith(brandRoot)) fail(403, 'The path escapes the brand directory.');
	const type = brandTypes[extname(target)];
	if (!type) fail(404, 'Unknown brand asset.');
	const body = await readLocalFile(target).catch(() => fail(404, 'Brand asset not found.'));
	sendText(response, body, type);
	return true;
}

/** Serve the workspace list and one file preview. Return true when it matched. */
async function workspaceRoute(rooms: Rooms, url: URL, response: ServerResponse): Promise<boolean> {
	if (url.pathname === '/workspace') {
		reply(
			response,
			200,
			await rooms.withWorkspace(async () => ({
				root: rooms.workspacePath,
				files: await listFiles(rooms.workspace),
			})),
		);
		return true;
	}
	if (url.pathname === '/file') {
		reply(
			response,
			200,
			await rooms.withWorkspace(() =>
				readFile(rooms.workspace, url.searchParams.get('path') ?? ''),
			),
		);
		return true;
	}
	return false;
}

async function sendFile(response: ServerResponse, file: URL, contentType: string): Promise<void> {
	sendText(response, await readLocalFile(file), contentType);
}

function sendText(response: ServerResponse, body: string | Buffer, contentType: string): void {
	response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
	response.end(body);
}

async function roomRoute(
	rooms: Rooms,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
) {
	const match =
		/^\/rooms\/([a-z][a-z0-9-]*)(?:\/(messages|exchanges|humans|resume|stop|abort)(?:\/([^/]+))?)?$/.exec(
			url.pathname,
		);
	if (!match) fail(404, 'Unknown route.');
	const [, name = '', resource = '', id] = match;
	if (!resource) {
		if (request.method !== 'GET') fail(405, 'Use GET for room reads.');
		return selectedRoom(rooms, name, url, response);
	}
	if (request.method === 'GET') return read(rooms, name, resource, id, url, response);
	if (resource === 'humans') return human(rooms, name, id ?? '', request, response);
	if (request.method !== 'POST' || id) fail(405, 'Use POST for lifecycle operations.');
	reply(response, 200, await rooms.lifecycle(name, resource));
}
async function collection(rooms: Rooms, request: IncomingMessage, response: ServerResponse) {
	if (request.method === 'GET') return reply(response, 200, await rooms.list());
	if (request.method !== 'POST') fail(405, 'Use GET or POST.');
	const input = await body(request);
	if (
		!isObject(input) ||
		typeof input.name !== 'string' ||
		!/^[a-z][a-z0-9-]{0,47}$/.test(input.name)
	)
		fail(400, 'Use a lowercase room name, up to 48 letters, digits, or dashes.');
	if (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 2000)
		fail(400, 'Supply a room goal of 1–2000 characters.');
	reply(response, 201, await rooms.create(input.name, input.goal.trim()));
}
async function human(
	rooms: Rooms,
	name: string,
	id: string,
	request: IncomingMessage,
	response: ServerResponse,
) {
	const person = people.find((candidate) => candidate.name === id);
	if (!person) fail(404, 'Unknown person.');
	const input = request.method === 'POST' ? await body(request) : undefined;
	const result = await rooms.withRoom(name, async (entry) =>
		mutateHuman(liveRoom(entry), person, request.method, input),
	);
	reply(response, request.method === 'POST' ? 202 : 200, result);
}
async function read(
	rooms: Rooms,
	name: string,
	resource: string,
	id: string | undefined,
	url: URL,
	response: ServerResponse,
) {
	if (id && resource !== 'exchanges') fail(404, 'Unknown route.');
	switch (resource) {
		case 'messages':
			return messagesRead(rooms, name, url, response);
		case 'exchanges':
			return exchangeRead(rooms, name, id, response);
		default:
			fail(404, 'Unknown route.');
	}
}

async function messagesRead(
	rooms: Rooms,
	name: string,
	url: URL,
	response: ServerResponse,
): Promise<void> {
	const since = Number(url.searchParams.get('since') ?? 0);
	if (!Number.isSafeInteger(since) || since < 0) fail(400, 'Invalid cursor.');
	return reply(response, 200, await rooms.messages(name, since));
}

async function exchangeRead(
	rooms: Rooms,
	name: string,
	id: string | undefined,
	response: ServerResponse,
): Promise<void> {
	const from = Number(id);
	if (!Number.isSafeInteger(from) || from < 1) fail(400, 'Invalid exchange reference.');
	const exchange = await rooms.exchange(name, from);
	if (!exchange) fail(404, 'Unknown exchange.');
	return reply(response, 200, exchange);
}

async function selectedRoom(
	rooms: Rooms,
	name: string,
	url: URL,
	response: ServerResponse,
): Promise<void> {
	const rawSince = url.searchParams.get('since');
	const since = rawSince === null ? undefined : Number(rawSince);
	if (since !== undefined && (!Number.isSafeInteger(since) || since < 0))
		fail(400, 'Invalid cursor.');
	return reply(response, 200, await rooms.read(name, since));
}

async function mutateHuman(
	room: Room,
	person: HumanDefinition,
	method: string | undefined,
	input: unknown,
) {
	const snapshot = await room.read({ messages: false });
	switch (method) {
		case 'DELETE':
			if (
				snapshot.participants.some(
					(seat) =>
						seat.name === person.name && seat.kind === 'human' && seat.presence === 'present',
				)
			)
				await (await room.visit(person)).leave();
			return { left: person.name };
		case 'PUT':
			await room.visit(person);
			return { joined: person.name };
		case 'POST': {
			if (
				!snapshot.participants.some(
					(seat) =>
						seat.name === person.name && seat.kind === 'human' && seat.presence === 'present',
				)
			)
				fail(409, 'Enter this room before sending.');
			if (!isDelivery(input))
				fail(400, 'Supply nonempty key and text, with an optional recipient.');
			const exchange = await (
				await room.visit(person)
			).send({ key: input.key, text: input.text, to: input.to });
			return { from: exchange.from, owner: exchange.owner, at: exchange.at };
		}
		default:
			fail(405, 'Use POST, PUT, or DELETE.');
	}
}

function checkOrigin(request: IncomingMessage): void {
	const origin = `http://${request.headers.host}`;
	const hostname = new URL(origin).hostname;
	if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) fail(403, 'Use a loopback address.');
	if (request.headers.origin && request.headers.origin !== origin)
		fail(403, 'Use the Workbench from its own origin.');
}

function reply(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
	response.end(JSON.stringify(value));
}
function errorStatus(error: unknown): number {
	return isObject(error) && typeof error.status === 'number' ? error.status : 500;
}
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
function isDelivery(value: unknown): value is { key: string; text: string; to?: string } {
	return (
		isObject(value) &&
		typeof value.key === 'string' &&
		value.key.length > 0 &&
		typeof value.text === 'string' &&
		value.text.trim().length > 0 &&
		(value.to === undefined || typeof value.to === 'string')
	);
}
async function body(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 16_384) fail(413, 'Request exceeds 16 KiB.');
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString());
}
