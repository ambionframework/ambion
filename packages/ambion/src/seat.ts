/**
 * A seat: one agent in one room, what wakes it, and the side of the wire
 * that runs its activations.
 *
 * A seat is the agent plus what the room knows about it while it is seated:
 * where its attention sits on the scale, and whether an activation of it is
 * live. The agent definition is a value and says none of that: the same
 * definition is the quiet corner in one room and the one who meets people in
 * another.
 *
 * Two things live here. The routing rule, because it is a fact about a seat
 * rather than about the room: every message has a reach, and a seat wakes
 * when its attention is at least that wide. And the seat's own actor: it
 * takes a wake, claims the lease, reads the room's view, builds the Pi
 * `Agent` over it with the hand the view names, runs it, renews the lease
 * while it runs, and releases the lease when it stops. Everything it knows
 * of the room, it learns through three calls (`wire.ts`).
 */
import type {
	AgentTool,
	AgentToolResult,
	Agent as PiAgent,
	Session as PiSession,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { Activation } from './activation.ts';
import { type Composing, type Draft, seatTool, standDown, summariseTool } from './assistant.ts';
import { persistTurns } from './log.ts';
import { refusal } from './render.ts';
import type { ModelResolver, Runtime, SessionOpener } from './runtime.ts';
import type { AgentDefinition, Attention, Message, Seq, SessionEvent } from './types.ts';
import { isAmbionTool, isSpoken } from './types.ts';
import type { ActivationView, CommitResponse, SeatPort, SeatRoom, Wake } from './wire.ts';
import { builtinTools, toolContext } from './workspace.ts';

// -- routing -----------------------------------------------------------------

/** The attention scale, narrowest first. A seat hears what it is wide enough for. */
const WIDTH: Record<Attention, number> = { none: 0, named: 1, broadcast: 2, presence: 3 };

/**
 * How wide a seat's attention has to be for this message to reach it: a
 * directed say reaches the one it names, anything else said reaches the room,
 * and a person arriving or leaving reaches the widest end.
 */
function reachOf(message: Message): Attention {
	if (!isSpoken(message)) return 'presence';
	return message.to === undefined ? 'broadcast' : 'named';
}

/**
 * One rule, read off the scale, in three lines. A seat the message names wakes,
 * however narrowly it is seated: a directed say names the one it addresses, and
 * a seating names the seat it seats. Everybody else wakes when their attention
 * is at least as wide as the message's reach — and a directed say reaches
 * nobody else at all. Rule 1 routes, rule 6 decides who sits out, and a
 * presence message is routed like any other.
 */
export function wakes(
	seat: { name: string; attention: Attention },
	target: string | undefined,
	message: Message,
	fromAssistant: boolean,
): boolean {
	// Nothing the assistant writes wakes anybody, with one exception written
	// into the line: a seating it committed wakes the seat it names. That is the
	// one activation the assistant can cause. The guard is on the author rather
	// than on what it wrote, so it holds for anything else it ever writes, and
	// every seat still reads it.
	if (fromAssistant) return message.kind === 'seated' && seat.name === target;
	if (seat.name === target) return true;
	const reach = reachOf(message);
	if (WIDTH[seat.attention] < WIDTH[reach]) return false;
	return reach !== 'named';
}

// -- tools --------------------------------------------------------------------

/**
 * One Pi tool from what a seat declared. A `defineTool` tool is handed a
 * `ToolContext` built for the seat's agent on every call, which is how it
 * reaches a workspace; a Pi-native tool passes through as it is, and its
 * signature has no room for one.
 */
function toPiTool(tool: unknown, agent: AgentDefinition): AgentTool {
	if (isAmbionTool(tool)) {
		return {
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (_toolCallId, params, signal) => {
				const result = await tool.execute(params, toolContext(agent, signal));
				return typeof result === 'string'
					? { content: [{ type: 'text', text: result }], details: {} }
					: result;
			},
		};
	}
	const raw = tool as AgentTool & { label?: string };
	if (typeof raw?.name !== 'string' || typeof raw?.execute !== 'function') {
		throw new Error('Tools must come from defineTool (Ambion or Pi).');
	}
	return raw.label ? raw : { ...raw, label: raw.name };
}

/** What a write tool returns when the record took it. */
function delivered(): AgentToolResult<Record<string, never>> {
	return { content: [{ type: 'text', text: 'delivered' }], details: {} };
}

/** What every hand a seat holds reaches: the activation it belongs to, and the room. */
export interface Hands {
	readonly activation: Activation;
	readonly room: SeatRoom;
	/** What a hand makes of the room's answer: a mark on the record, a refusal, or a lease that ended. */
	landed(response: CommitResponse): AgentToolResult<Record<string, never>>;
}

function hands(activation: Activation, room: SeatRoom): Hands {
	return {
		activation,
		room,
		landed(response) {
			if ('committed' in response) {
				activation.heard(response.committed.seq);
				activation.spoke = true;
				return delivered();
			}
			if ('refused' in response) throw new Error(response.refused);
			if ('missed' in response) {
				throw new Error('The room moved. Read what landed, then decide again.');
			}
			// The lease ended under this hand: the room is closing, or the seat
			// ran past its lease. Nothing it writes now lands, so the turn is over.
			activation.abort();
			return standDown(`Your turn ended: ${response.stale}.`) as AgentToolResult<
				Record<string, never>
			>;
		},
	};
}

/** The one hand every seat that speaks for itself holds. */
function sayTool(hands: Hands): AgentTool {
	return {
		name: 'say',
		label: 'say',
		description:
			'Speak on the record. Omit `to` to address the room; set `to` to a participant name ' +
			'to address them directly — a directed say to an agent also calls them in. ' +
			'Ending your turn without calling say is declining to speak.',
		parameters: Type.Object({
			to: Type.Optional(Type.String({ description: 'A participant name from the roster.' })),
			text: Type.String(),
		}),
		execute: async (toolCallId, rawParams) => {
			const params = rawParams as { to?: string; text: string };
			const to = params.to?.trim() ? params.to.trim() : undefined;
			const text = params.text.trim();
			// A message with nothing in it still takes a seq, renders in
			// every context after it, and stands inside whatever range a
			// summary covers. Saying nothing is ending the activation.
			if (text === '') {
				throw new Error('The message is empty. Say something, or end your turn instead.');
			}
			const response = await hands.room.commit({
				activation: hands.activation.id,
				key: toolCallId,
				readThrough: hands.activation.readThrough,
				intent: { kind: 'said', ...(to === undefined ? {} : { to }), text },
			});
			if ('missed' in response) {
				// Now heard, the seat decides again against the record as it stands.
				hands.activation.heard(response.missed.at(-1)?.seq ?? 0);
				throw new Error(
					refusal(
						'Not delivered — the room moved while you were speaking. New on the record:',
						response.missed,
						'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
					),
				);
			}
			return hands.landed(response);
		},
	};
}

/**
 * What an activation holds. A seat speaks, reaches its workspace through the
 * four built-in tools when it names one, and uses its own tools; the assistant
 * holds the one hand its view names, and it reaches the record. `startSession`
 * refuses an assistant that carries tools or a workspace of its own, so there
 * is nothing else to leave out.
 */
function handsFor(view: ActivationView, def: AgentDefinition, held: Hands): AgentTool[] {
	if (view.hand === 'say') {
		return [sayTool(held), ...builtinTools(def), ...def.tools.map((tool) => toPiTool(tool, def))];
	}
	if (view.hand === 'summarise' && view.closing) {
		const draft: Draft = { ...view.closing, refusals: 0, calls: 0 };
		return [summariseTool(held, draft)];
	}
	if (view.hand === 'seat' && view.composing) {
		const composing: Composing = { ...view.composing, seated: 0, calls: 0 };
		return [seatTool(held, composing)];
	}
	return [];
}

// -- the actor ----------------------------------------------------------------

/** What a seat actor needs beside the room: the runtime, and the model call the room chose. */
export interface SeatContext {
	readonly runtime: Runtime;
	readonly room: string;
	readonly seat: string;
	/** Where the seat's audit session opens, `<room>:<seat>`, beside the room's. */
	readonly sessions: SessionOpener;
	readonly stream: StreamFn;
	readonly model: ModelResolver;
	/** Where in-process events go. Absent across a process boundary. */
	readonly emit?: (event: SessionEvent) => void;
}

/**
 * The seat's side of the wire. One actor per seat, for as long as the room
 * runs; one activation at a time, named by the wake that started it.
 */
export class SeatActor implements SeatPort {
	private current: { id: string; activation: Activation } | undefined;
	/** A wake that arrived while an activation ran. It runs next. */
	private queued: string | undefined;
	private audit: Promise<PiSession> | undefined;

	constructor(
		private readonly room: SeatRoom,
		private readonly context: SeatContext,
	) {}

	/**
	 * A wake starts an activation when none runs. While one runs, a wake a
	 * message caused is steered into it (rule 2), and the lease says so; any
	 * other wake runs next.
	 */
	async wake(wake: Wake): Promise<void> {
		if (this.current === undefined) {
			void this.run(wake.activation);
			return;
		}
		if (this.current.id === wake.activation) return;
		if (wake.steer === undefined) {
			this.queued = wake.activation;
			return;
		}
		const activation = this.current.activation;
		if (activation.steer(wake.steer.seq, wake.steer.line)) await this.renew(activation);
	}

	/**
	 * One activation to its end: claim, run, release, then whatever queued
	 * behind it. A host that runs a seat inside one request awaits this.
	 */
	async run(id: string): Promise<void> {
		if (this.current !== undefined) {
			this.queued = id;
			return;
		}
		await this.take(id);
	}

	/** Cut the activation in flight. The room writes what that means. */
	abort(): void {
		this.current?.activation.abort();
	}

	private async take(id: string): Promise<void> {
		// Held before the claim, so a steer that lands while the claim is in
		// flight reaches the activation and not the floor.
		const activation = new Activation(id, this.context.seat, this.host(id));
		this.current = { id, activation };
		const claimed = await this.claim(id);
		if (claimed === undefined) {
			this.current = undefined;
			return this.next();
		}
		const stopRenewing = this.renewUntil(activation, claimed.expiry);
		try {
			await activation.run();
		} finally {
			stopRenewing();
			this.current = undefined;
			await this.release(id, activation);
		}
		this.next();
	}

	/** The lease, or nothing: the room refused it, or the claim never came back. The wake is sent again. */
	private async claim(id: string): Promise<{ expiry: number } | undefined> {
		try {
			const claimed = await this.room.lease({ activation: id, phase: 'running' });
			return 'stale' in claimed ? undefined : claimed.ok;
		} catch {
			return undefined;
		}
	}

	private next(): void {
		const queued = this.queued;
		this.queued = undefined;
		if (queued !== undefined) void this.take(queued);
	}

	/** The lease is released, however the activation went. A room that is gone answers stale, and that is fine. */
	private async release(id: string, activation: Activation): Promise<void> {
		try {
			await this.room.lease({
				activation: id,
				phase: 'ended',
				reason: activation.reason,
				heard: activation.taken,
			});
		} catch {
			// The release never reached the room: the lease expires there, which
			// the room reports as a failed activation.
		}
	}

	/** One renewal, carrying what the activation has taken. A refused renewal ends it. */
	private async renew(activation: Activation): Promise<number | undefined> {
		try {
			const renewed = await this.room.lease({
				activation: activation.id,
				phase: 'running',
				heard: activation.taken,
			});
			if ('stale' in renewed) {
				activation.abort();
				return undefined;
			}
			return renewed.ok.expiry;
		} catch {
			// The renewal never reached the room: the lease expires there, and
			// the next call this seat makes is answered stale.
			return undefined;
		}
	}

	/** Renew at half the expiry, for as long as the activation runs. */
	private renewUntil(activation: Activation, firstExpiry: number): () => void {
		const clock = this.context.runtime.clock;
		let cancel = () => {};
		const schedule = (expiry: number) => {
			cancel = clock.alarm(clock.now() + (expiry - clock.now()) / 2, () => void again());
		};
		const again = async () => {
			const expiry = await this.renew(activation);
			if (expiry !== undefined) schedule(expiry);
		};
		schedule(firstExpiry);
		return () => cancel();
	}

	private host(id: string) {
		const { runtime, room, seat, sessions } = this.context;
		return {
			view: () => this.room.view(id),
			renew: (heard: Seq) => this.room.lease({ activation: id, phase: 'running', heard }),
			build: (view: ActivationView, activation: Activation) => this.build(view, activation),
			persist: (agent: PiAgent) => {
				this.audit ??= sessions.open(`${room}:${seat}`, room);
				return persistTurns(this.audit, agent, new Date(runtime.clock.now()).toISOString());
			},
			emit: (event: SessionEvent) => this.context.emit?.(event),
			now: () => runtime.clock.now(),
		};
	}

	/** The model over the view: the prompt the room rendered, the model the definition names, the hands. */
	private build(view: ActivationView, activation: Activation): PiAgent {
		const def = this.context.runtime.catalog.get(view.seat);
		if (def === undefined) throw new Error(`'${view.seat}' is not in the runtime's catalog.`);
		return new Agent({
			streamFn: this.context.stream,
			initialState: {
				systemPrompt: view.systemPrompt,
				model: this.context.model(view.model, def.name),
				thinkingLevel: 'off',
				tools: handsFor(view, def, hands(activation, this.room)),
				messages: [],
			},
		});
	}
}
