/**
 * The same room as a Cloudflare Worker: one Durable Object holds the record
 * and the session, and one holds each seat. The products, the specialists on
 * call, their APIs, the people and the assistant all come from `room.ts`
 * unchanged, so the room a person reaches here is the room `main.ts` opens.
 *
 * `configure()` names the catalog once at module scope. Every object in the
 * isolate resolves a seat name through it.
 *
 * Run it:  ANTHROPIC_API_KEY=… pnpm dev:cloudflare   (from examples/site)
 */
import type { AgentSeat } from '@ambionframework/ambion';
import { isSeatedAgent } from '@ambionframework/ambion';
import type { Env, SeatSpec } from '@ambionframework/cloudflare';
import { configure, RoomObject, SeatObject, sqlSessions } from '@ambionframework/cloudflare';
import { AGENTS, ASSISTANT, AVAILABLE, dan, GOAL, priya, ROOM_NAME, sam } from './room.ts';

/** The definition a seat carries, whether the room's list gave it an attention or not. */
const definitionOf = (seat: AgentSeat) => (isSeatedAgent(seat) ? seat.agent : seat);

/** The same seat as a name the worker resolves, with the attention it carries. */
const specOf = (seat: AgentSeat): SeatSpec =>
	isSeatedAgent(seat) ? { name: seat.agent.name, attention: seat.attention } : seat.name;

configure({
	agents: [ASSISTANT, ...AGENTS, ...AVAILABLE].map(definitionOf),
	// A wake nobody takes is sent again this often. Alarms fire on their own here.
	wake: { resend: 2_000 },
});

/**
 * The room, with two calls a demo needs and a room in service does not.
 * `journal` reads the entries beside the messages, and `crash` drops the object the
 * way the platform may drop it: the seats around it keep running, and the
 * next call to this name builds the room again over the same storage.
 */
export class DemoRoom extends RoomObject {
	async journal(): Promise<{ type: string; data: unknown }[]> {
		// The name the object was started with, and not the one this module
		// holds: a worker that served a second room would read the wrong journal,
		// and an id nothing wrote opens as an empty session rather than failing.
		const name = await this.ctx.storage.get<string>('name');
		if (name === undefined) throw new Error('The room is not started.');
		const piSession = await sqlSessions(this.ctx).open(name);
		const entries = await piSession.findEntries();
		entries.sort((a, b) => a.seq - b.seq);
		return entries.flatMap((entry) =>
			entry.type === 'custom' ? [{ type: entry.customType, data: entry.data }] : [],
		);
	}

	async crash(): Promise<void> {
		this.ctx.abort('the demo takes the room while the seats work');
	}
}

export { SeatObject };

const PEOPLE = [priya, sam, dan];

/** The composition the room starts with: the same one `main.ts` and `demo.ts` use. */
const COMPOSITION = {
	name: ROOM_NAME,
	assistant: ASSISTANT.name,
	agents: AGENTS.map(specOf),
	available: AVAILABLE.map(specOf),
	goal: GOAL,
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { 'content-type': 'application/json' },
	});

/** The one room this worker serves, by the name its composition carries. */
function room(env: DemoEnv) {
	return env.ROOM.get(env.ROOM.idFromName(ROOM_NAME));
}

function personOf(name: string) {
	const person = PEOPLE.find((p) => p.name === name);
	if (person === undefined) throw new Error(`'${name}' is not one of the people in this room.`);
	return { name: person.name, identity: person.identity, preferences: person.preferences };
}

/** The bindings this worker holds: the room is the demo's own subclass. */
interface DemoEnv extends Omit<Env, 'ROOM'> {
	ROOM: DurableObjectNamespace<DemoRoom>;
}

/** The room object as the worker holds it: what `ROOM.get` hands back. */
type RoomStub = DurableObjectStub<DemoRoom>;

/** One route: the method and path it answers, and what it does to the room. */
type Route = (stub: RoomStub, request: Request, url: URL) => Promise<unknown>;

/**
 * The routes. `start` composes the room, `visit` puts a person in it,
 * `deliver` asks a question, and the reads report what the journal holds.
 * Nothing here is a channel: it is the smallest surface that drives a room.
 */
const ROUTES: Record<string, Route> = {
	'POST /start': async (stub) => {
		await stub.start(COMPOSITION);
		return { started: ROOM_NAME, seats: await stub.seats() };
	},
	'POST /visit': async (stub, request) => {
		const { person } = (await request.json()) as { person: string };
		await stub.visit(personOf(person));
		return { visited: person };
	},
	'POST /deliver': async (stub, request) => {
		const body = (await request.json()) as { from: string; text: string; key?: string };
		await stub.deliver(body);
		return { delivered: body.text };
	},
	'POST /stop': async (stub) => {
		await stub.stop();
		return { stopped: ROOM_NAME };
	},
	'GET /messages': async (stub, _request, url) => {
		const since = url.searchParams.get('since');
		return stub.messages(since === null ? undefined : Number(since));
	},
	'GET /seats': async (stub) => stub.seats(),
	'GET /journal': async (stub) => stub.journal(),
	'POST /crash': async (stub) => {
		// The object goes away without answering: the call it never finishes is
		// the crash, so the demo reads this failure as the room going down.
		await stub.crash().catch(() => {});
		return { crashed: ROOM_NAME };
	},
	'GET /exchange': async (stub) => (await stub.exchange()) ?? null,
};

async function route(request: Request, env: DemoEnv): Promise<Response> {
	const url = new URL(request.url);
	const taken = ROUTES[`${request.method} ${url.pathname}`];
	if (taken === undefined) return json({ routes: Object.keys(ROUTES) }, 404);
	return json(await taken(room(env), request, url));
}

export default {
	async fetch(request: Request, env: DemoEnv): Promise<Response> {
		try {
			return await route(request, env);
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : String(error) }, 500);
		}
	},
};
