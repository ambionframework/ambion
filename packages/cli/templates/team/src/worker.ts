import type { SeatInfo, Seq } from '@ambionframework/ambion';
import type { Env } from '@ambionframework/cloudflare';
import { configure, RoomObject, SeatObject } from '@ambionframework/cloudflare';
import { AGENTS, COMPOSITION, human, ROOM_NAME } from './room.ts';

configure({
	// The catalog is fixed at module load. Room metadata stores these names
	// so a Durable Object can resolve them after it resumes.
	agents: AGENTS,
	wake: { resend: 2_000 },
});

interface TeamEnv extends Env {
	ROOM: DurableObjectNamespace<RoomObject>;
	SEAT: DurableObjectNamespace<SeatObject>;
}

type RoomStub = DurableObjectStub<RoomObject>;

class RequestError extends Error {}

const json = (value: unknown, status = 200): Response =>
	new Response(JSON.stringify(value, null, 2), {
		status,
		headers: { 'content-type': 'application/json' },
	});

const room = (env: TeamEnv): RoomStub => env.ROOM.get(env.ROOM.idFromName(ROOM_NAME));

const person = {
	name: human.name,
	identity: human.identity,
	...(human.preferences === undefined ? {} : { preferences: human.preferences }),
};

const numberParam = (url: URL, name: string): Seq | undefined => {
	const value = url.searchParams.get(name);
	if (value === null) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0)
		throw new RequestError(`'${name}' must be a sequence number.`);
	return parsed;
};

async function body(request: Request): Promise<Record<string, unknown>> {
	let value: unknown;
	try {
		value = await request.json();
	} catch {
		throw new RequestError('The request body must contain valid JSON.');
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new RequestError('The request body must be a JSON object.');
	}
	return value as Record<string, unknown>;
}

function textOf(value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '')
		throw new RequestError("'text' must be a non-empty string.");
	return value;
}

async function start(stub: RoomStub): Promise<{ started: string; participants: SeatInfo[] }> {
	await stub.start(COMPOSITION);
	return { started: ROOM_NAME, participants: await stub.participants() };
}

async function join(
	stub: RoomStub,
	request: Request,
): Promise<{ joined: string; participants: SeatInfo[] }> {
	const input = request.headers.get('content-type') === null ? {} : await body(request);
	const name = input.name === undefined ? human.name : input.name;
	if (typeof name !== 'string' || name !== human.name)
		throw new RequestError(`'${name}' is not a person in this room.`);
	await stub.visit(person);
	return { joined: name, participants: await stub.participants() };
}

async function send(stub: RoomStub, request: Request): Promise<unknown> {
	const input = await body(request);
	const from = input.from === undefined ? human.name : input.from;
	if (typeof from !== 'string' || from !== human.name)
		throw new RequestError(`'${from}' is not a person in this room.`);
	const to = input.to;
	if (to !== undefined && typeof to !== 'string')
		throw new RequestError("'to' must be a participant name.");
	const key = input.key;
	if (key !== undefined && typeof key !== 'string')
		throw new RequestError("'key' must be a string.");
	return stub.send({
		from,
		text: textOf(input.text),
		...(to === undefined ? {} : { to }),
		...(key === undefined ? {} : { key }),
	});
}

async function exchange(stub: RoomStub, url: URL): Promise<unknown> {
	const from = numberParam(url, 'from');
	return from === undefined ? null : ((await stub.exchange(from)) ?? null);
}

async function route(request: Request, env: TeamEnv): Promise<Response> {
	const url = new URL(request.url);
	const stub = room(env);
	if (request.method === 'POST' && url.pathname === '/start') return json(await start(stub));
	if (request.method === 'POST' && url.pathname === '/join') return json(await join(stub, request));
	if (request.method === 'POST' && url.pathname === '/send') return json(await send(stub, request));
	if (request.method === 'GET' && url.pathname === '/messages') {
		return json(await stub.messages(numberParam(url, 'since')));
	}
	if (request.method === 'GET' && url.pathname === '/exchange')
		return json(await exchange(stub, url));
	return json(
		{
			error: 'Route not found.',
			routes: ['POST /start', 'POST /join', 'POST /send', 'GET /messages', 'GET /exchange'],
		},
		404,
	);
}

export { RoomObject, SeatObject };

export default {
	async fetch(request: Request, env: TeamEnv): Promise<Response> {
		try {
			return await route(request, env);
		} catch (error) {
			return json(
				{ error: error instanceof Error ? error.message : String(error) },
				error instanceof RequestError ? 400 : 500,
			);
		}
	},
};
