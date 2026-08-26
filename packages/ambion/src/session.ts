import type {
	AgentTool,
	AgentToolResult,
	Session as PiSession,
	SessionRepo,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { Agent, InMemorySessionRepo } from '@earendil-works/pi-agent-core';
import type { Api, Model, UserMessage } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { Type } from 'typebox';
import {
	type AgentDefinition,
	type HumanDefinition,
	isAgent,
	isAmbionTool,
	isHuman,
	isPassiveSeat,
	type Message,
	type Participant,
	type SeatInfo,
	type SessionEvent,
} from './types.ts';

/** The record lives as custom entries of this type in a Pi session. */
const MESSAGE_ENTRY = 'ambion/message';

const defaultRepo = new InMemorySessionRepo();

/** Pi's model registry, built once on first use. */
let builtinRegistry: ReturnType<typeof builtinModels> | undefined;
const registry = () => (builtinRegistry ??= builtinModels());

export interface OpenSessionOptions {
	/** The session's name: open it again and you are back in it, record intact. */
	name: string;
	participants: readonly Participant[];
	/**
	 * Override the model call — Pi's own extension surface, and the only one
	 * here: a scripted stream makes the room deterministic, a custom stream
	 * brings custom providers. When omitted, models resolve from Pi's builtin
	 * registry, `provider/model-id`.
	 */
	streamFn?: StreamFn;
	/** Pi's own session repository. Defaults to a process-wide `InMemorySessionRepo`. */
	repo?: SessionRepo;
}

export interface Deliver {
	from: HumanDefinition;
	/** Directed delivery: activates exactly the named participant, waking it idle or passive. */
	to?: AgentDefinition | HumanDefinition;
	text: string;
}

export interface Session {
	readonly name: string;
	deliver(input: Deliver): Promise<void>;
	subscribe(listener: (event: SessionEvent) => void): () => void;
	/** Resolves when no agent is active and nothing is queued. */
	settled(): Promise<void>;
	/** Cancel every active turn; what was said stays, what was mid-flight ends without speaking. */
	abort(): void;
	messages(): Promise<Message[]>;
	seats(): SeatInfo[];
}

interface SeatRuntime {
	def: AgentDefinition;
	passive: boolean;
	active: boolean;
	spoke: boolean;
	/** Pi's abort() cancels the run but not its queues; this stops the rebuild loop too. */
	aborted: boolean;
	/**
	 * How much of the record this seat has provably heard: the prefix its view
	 * rendered, advanced as steers land in the transcript and by its own says.
	 * A say commits only against a fully heard record — see sayTool.
	 */
	viewSeq: number;
	/** Record seqs of steers enqueued to the live agent, awaiting their drain (FIFO). */
	pendingSteers: number[];
	agent?: Agent;
	/** The seat's downstream Pi session — every activation's full turns, kept for audit. */
	piSeat?: Promise<PiSession>;
}

export function openSession(options: OpenSessionOptions): Session {
	return new SessionImpl(options);
}

class SessionImpl implements Session {
	readonly name: string;
	private readonly repo: SessionRepo;
	private readonly ready: Promise<PiSession>;
	private readonly record: Message[] = [];
	private readonly humans = new Map<string, HumanDefinition>();
	private readonly agents = new Map<string, SeatRuntime>();
	private readonly listeners = new Set<(event: SessionEvent) => void>();
	private readonly settledWaiters: (() => void)[] = [];
	private readonly streamFn: StreamFn;
	/** True when a custom streamFn is in play: it never reads the model, so a stub suffices. */
	private readonly customStream: boolean;
	private activeCount = 0;
	private persistTail: Promise<void> = Promise.resolve();

	constructor(options: OpenSessionOptions) {
		this.name = options.name;
		this.repo = options.repo ?? defaultRepo;
		this.ready = this.openStore(this.repo);

		for (const participant of options.participants) {
			const def = isPassiveSeat(participant) ? participant.agent : participant;
			if (this.humans.has(def.name) || this.agents.has(def.name)) {
				throw new Error(
					`Duplicate participant name '${def.name}': one name names one participant.`,
				);
			}
			if (isHuman(def)) {
				this.humans.set(def.name, def);
			} else if (isAgent(def)) {
				this.agents.set(def.name, {
					def,
					passive: isPassiveSeat(participant),
					active: false,
					spoke: false,
					aborted: false,
					viewSeq: 0,
					pendingSteers: [],
				});
			} else {
				throw new Error('Participants must come from defineAgent, defineHuman, or passive().');
			}
		}

		this.customStream = options.streamFn !== undefined;
		this.streamFn =
			options.streamFn ??
			((model, context, streamOptions) => {
				const envKey = process.env[`${model.provider.toUpperCase().replace(/-/g, '_')}_API_KEY`];
				const resolved =
					streamOptions?.apiKey || !envKey ? streamOptions : { ...streamOptions, apiKey: envKey };
				return registry().streamSimple(model, context, resolved);
			});
	}

	/** Open the name into its Pi session — creating it on first open — and load the record. */
	private async openStore(repo: SessionRepo): Promise<PiSession> {
		const piSession = await openOrCreate(repo, this.name);
		const entries = await piSession.findEntries();
		// findEntries does not promise append order; seq does.
		entries.sort((a, b) => a.seq - b.seq);
		for (const entry of entries) {
			if (entry.type === 'custom' && entry.customType === MESSAGE_ENTRY) {
				this.record.push(entry.data as Message);
			}
		}
		return piSession;
	}

	/**
	 * The seat's downstream Pi session, `<room>:<agent>`, parented to the
	 * room's — where every activation's full turns land, so hands stay
	 * auditable after the fact even though working views reset at idle.
	 */
	private seatSession(seat: SeatRuntime): Promise<PiSession> {
		seat.piSeat ??= (async () => {
			await this.ready;
			return openOrCreate(this.repo, `${this.name}:${seat.def.name}`, this.name);
		})();
		return seat.piSeat;
	}

	async deliver(input: Deliver): Promise<void> {
		const from = this.humans.get(input.from?.name ?? '');
		if (!from || from !== input.from) {
			throw new Error('deliver() takes a seated human handle as from.');
		}
		let to: string | undefined;
		if (input.to) {
			const name = input.to.name;
			if (!this.humans.has(name) && !this.agents.has(name)) {
				throw new Error(`Cannot direct a delivery to '${name}': not seated in this session.`);
			}
			to = name;
		}
		await this.ready;
		const message = this.commit(from.name, to, input.text);
		const seq = this.record.length;
		await this.persistTail;
		this.emit({ type: 'delivery', message });
		this.dispatch(message, seq, true);
	}

	subscribe(listener: (event: SessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	settled(): Promise<void> {
		if (this.activeCount === 0) return Promise.resolve();
		return new Promise((resolve) => this.settledWaiters.push(resolve));
	}

	abort(): void {
		for (const seat of this.agents.values()) {
			if (seat.active) {
				seat.aborted = true;
				seat.agent?.abort();
			}
		}
	}

	async messages(): Promise<Message[]> {
		await this.ready;
		return [...this.record];
	}

	seats(): SeatInfo[] {
		const seats: SeatInfo[] = [];
		for (const human of this.humans.values()) {
			seats.push({ name: human.name, kind: 'human', identity: human.identity });
		}
		for (const seat of this.agents.values()) {
			seats.push({
				name: seat.def.name,
				kind: 'agent',
				identity: seat.def.identity,
				status: seat.active ? 'active' : seat.passive ? 'passive' : 'idle',
				sessionId: `${this.name}:${seat.def.name}`,
			});
		}
		return seats;
	}

	// -- the room ------------------------------------------------------------

	/**
	 * Claim the record's next slot, synchronously — the say tool's conflict
	 * check and this push must share one tick, or a rival say could slip
	 * between them. Persistence follows in commit order on a write chain.
	 * Callers run after `ready` (deliver awaits it; a say implies a run).
	 */
	private commit(from: string, to: string | undefined, text: string): Message {
		const message: Message = { from, text, at: new Date().toISOString() };
		if (to) message.to = to;
		this.record.push(message);
		this.persistTail = this.persistTail.then(async () => {
			const piSession = await this.ready;
			await piSession.appendCustomEntry(MESSAGE_ENTRY, message);
		});
		return message;
	}

	private emit(event: SessionEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A listener's failure is the listener's problem, never the room's.
			}
		}
	}

	/**
	 * Route a committed message — the room's whole policy in one place.
	 * Every colleague still at work hears it as a steer (rule 2); a named
	 * target is woken at rest, passive included (rules 1, 4). `wake` is
	 * rule 4's asymmetry in one flag: a broadcast delivery wakes the idle
	 * room, an agent's undirected say wakes no one who has gone idle.
	 */
	private dispatch(message: Message, seq: number, wake: boolean): void {
		const target = message.to !== undefined ? this.agents.get(message.to) : undefined;
		for (const seat of this.agents.values()) {
			if (seat.def.name === message.from) continue;
			if (seat.active) {
				this.steerInto(seat, message, seq);
			} else if (seat === target || (message.to === undefined && wake && !seat.passive)) {
				this.activate(seat);
			}
		}
	}

	private steerInto(seat: SeatRuntime, message: Message, seq: number): void {
		seat.pendingSteers.push(seq);
		seat.agent?.steer(userMessage(`[new] ${renderLine(message)}`));
	}

	private activate(seat: SeatRuntime): void {
		seat.active = true;
		seat.spoke = false;
		seat.aborted = false;
		this.activeCount += 1;
		this.emit({ type: 'agent_start', agent: seat.def.name });
		void this.run(seat).finally(() => {
			seat.active = false;
			seat.agent = undefined;
			this.emit({ type: 'agent_end', agent: seat.def.name, spoke: seat.spoke });
			this.activeCount -= 1;
			if (this.activeCount === 0) {
				this.emit({ type: 'settled' });
				for (const resolve of this.settledWaiters.splice(0)) resolve();
			}
		});
	}

	private async run(seat: SeatRuntime): Promise<void> {
		for (;;) {
			try {
				// A fresh view hands the seat the whole record: heard up to here.
				seat.viewSeq = this.record.length;
				seat.pendingSteers = [];
				const agent = this.buildAgent(seat);
				seat.agent = agent;
				await agent.prompt(userMessage(this.renderContext(seat)));
				await this.persistRun(seat, agent);
				const failure = runFailure(agent);
				if (failure) {
					this.emit({ type: 'error', agent: seat.def.name, error: failure });
					return;
				}
				// An aborted turn stays cancelled: Pi's abort() ends the run but
				// leaves its queues, and a queued steer must not rebuild the turn.
				if (seat.aborted) return;
				// A steer that raced past the run's last drain is not lost: the
				// message is already on the record, so a fresh view carries it.
				if (!agent.hasQueuedMessages()) return;
				agent.clearAllQueues();
			} catch (error) {
				this.emit({ type: 'error', agent: seat.def.name, error: toError(error) });
				return;
			}
		}
	}

	private async persistRun(seat: SeatRuntime, agent: Agent): Promise<void> {
		const piSeat = await this.seatSession(seat);
		await piSeat.appendCustomEntry('ambion/activation', { at: new Date().toISOString() });
		for (const message of agent.state.messages) {
			// Provider messages may carry undefined-valued fields, which Pi's
			// durability check rejects; a JSON round-trip drops them.
			await piSeat.appendMessage(JSON.parse(JSON.stringify(message)));
		}
	}

	private buildAgent(seat: SeatRuntime): Agent {
		const agent = new Agent({
			streamFn: this.streamFn,
			initialState: {
				systemPrompt: this.systemPrompt(seat),
				model: this.resolveModel(seat.def),
				thinkingLevel: 'off',
				tools: [this.sayTool(seat), ...seat.def.tools.map(toPiTool)],
				messages: [],
			},
		});
		agent.subscribe((event) => {
			if (event.type === 'message_start' && event.message.role === 'user') {
				// A steer has landed in the transcript: the seat has now heard it.
				// Steers drain FIFO, so the oldest pending seq is the one that landed.
				const content = event.message.content;
				if (typeof content === 'string' && content.startsWith('[new] ')) {
					const seq = seat.pendingSteers.shift();
					if (seq !== undefined) seat.viewSeq = Math.max(seat.viewSeq, seq);
				}
			} else if (event.type === 'tool_execution_start' && event.toolName !== 'say') {
				this.emit({
					type: 'tool_execution_start',
					agent: seat.def.name,
					toolName: event.toolName,
				});
			} else if (event.type === 'tool_execution_end' && event.toolName !== 'say') {
				this.emit({ type: 'tool_execution_end', agent: seat.def.name, toolName: event.toolName });
			}
		});
		return agent;
	}

	private sayTool(seat: SeatRuntime): AgentTool {
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
			execute: async (_toolCallId, rawParams) => {
				const params = rawParams as { to?: string; text: string };
				const to = params.to?.trim() ? params.to.trim() : undefined;
				if (to !== undefined && !this.humans.has(to) && !this.agents.has(to)) {
					throw new Error(`Unknown participant '${to}'. Address someone from the roster.`);
				}
				if (to === seat.def.name) {
					throw new Error('You cannot address yourself.');
				}
				// Optimistic locking: a say commits only against a record its seat
				// has heard in full. The check and the commit below share one tick,
				// so exactly one of two racing says wins; the loser's failure carries
				// what it missed — a steer with a delivery guarantee.
				if (this.record.length > seat.viewSeq) {
					const missed = this.record.slice(seat.viewSeq);
					seat.viewSeq = this.record.length;
					this.emit({ type: 'say_conflict', agent: seat.def.name, missed });
					throw new Error(
						[
							'Not delivered — the room moved while you were speaking. New on the record:',
							...missed.map(renderLine),
							'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
						].join('\n'),
					);
				}
				const message = this.commit(seat.def.name, to, params.text);
				const seq = this.record.length;
				seat.viewSeq = seq;
				seat.spoke = true;
				await this.persistTail;
				// A say is atomic: one event, the whole message, exactly as it landed
				// on the record. Finer granularity belongs to the seat's own layer.
				this.emit({ type: 'say', agent: seat.def.name, message });
				this.dispatch(message, seq, false);
				const result: AgentToolResult<Record<string, never>> = {
					content: [{ type: 'text', text: 'delivered' }],
					details: {},
				};
				return result;
			},
		};
	}

	private systemPrompt(seat: SeatRuntime): string {
		const roster = this.seats()
			.map((s) => `- ${s.name} (${s.kind === 'human' ? 'human' : s.status}): ${s.identity}`)
			.join('\n');
		return [
			`You are '${seat.def.name}', an agent seated in the session '${this.name}' — a shared`,
			`room with a record. Every participant sees what is said; nobody sees your tool use.`,
			``,
			`The roster (active: taking a turn now; idle: hears every message; passive: hears`,
			`only a say directed at them — a broadcast will not reach a passive colleague):`,
			roster,
			``,
			`Speaking is the say tool. Silence is the default: if this does not concern you, end`,
			`your turn without saying anything, and no mark is left. Speak only when your reply`,
			`adds something the record does not already hold — new information, a decision moved`,
			`forward, or a genuinely different perspective. A point already made does not need a`,
			`second voice; restating it in your own words is repetition, not contribution — stay`,
			`silent instead. A directed say (to: a name) calls that agent in; use it deliberately —`,
			`attention costs money. When a colleague holds the answer, ask them directly with one`,
			`directed say — never announce to the room what you are about to do, and never pose a`,
			`question undirected that only one participant can answer: a say is a message, not a`,
			`thought. Messages arriving mid-turn are marked [new]; fold them into what you are`,
			`doing — and if a colleague has just made your point, let it stand. A say fails if`,
			`the room moved while you were speaking: the failure lists what you missed — read`,
			`it, and speak again only if your reply still adds something.`,
			``,
			`Your identity, as the room knows it: ${seat.def.identity}`,
			``,
			`Your instructions:`,
			seat.def.instructions.trim(),
		].join('\n');
	}

	private renderContext(seat: SeatRuntime): string {
		const transcript =
			this.record.length === 0 ? '(the record is empty)' : this.record.map(renderLine).join('\n');
		return [
			`The record of '${this.name}' so far:`,
			transcript,
			``,
			`Take your turn, ${seat.def.name}: say something, or end your turn to stay silent.`,
		].join('\n');
	}

	private resolveModel(def: AgentDefinition): Model<Api> {
		if (this.customStream) {
			// A custom streamFn never reads the model; a stub keeps Pi's loop satisfied.
			return {
				id: def.model,
				name: def.model,
				api: 'scripted',
				provider: 'scripted',
			} as unknown as Model<Api>;
		}
		const slash = def.model.indexOf('/');
		if (slash > 0) {
			const model = registry().getModel(def.model.slice(0, slash), def.model.slice(slash + 1));
			if (model) return model;
		}
		throw new Error(
			`Unknown model '${def.model}' for agent '${def.name}': expected 'provider/model-id'.`,
		);
	}
}

/** Open an id into its Pi session, creating it on first open. */
async function openOrCreate(
	repo: SessionRepo,
	id: string,
	parentSessionId?: string,
): Promise<PiSession> {
	const known = (await repo.list()).find((metadata) => metadata.id === id);
	if (known) return repo.open(known);
	return repo.create(parentSessionId ? { id, parentSessionId } : { id });
}

function renderLine(message: Message): string {
	return `[${message.from}${message.to ? ` → ${message.to}` : ''}] ${message.text}`;
}

function userMessage(text: string): UserMessage {
	return { role: 'user', content: text, timestamp: Date.now() };
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function runFailure(agent: Agent): Error | undefined {
	const last = agent.state.messages.at(-1);
	if (last && 'stopReason' in last && last.stopReason === 'error') {
		return new Error(('errorMessage' in last && last.errorMessage) || 'The turn failed.');
	}
	return undefined;
}

function toPiTool(tool: unknown): AgentTool {
	if (isAmbionTool(tool)) {
		return {
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (_toolCallId, params, signal) => {
				const result = await tool.execute(params, signal);
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
