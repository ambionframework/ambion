/**
 * The room tools of one activation, and the agent's own tools, in a shape
 * that names no harness.
 *
 * Every respond activation can speak, schedule a say to itself, seat an
 * agent, remove an agent, dismiss a scheduled say, or recall messages of the
 * room by URI. A summary activation
 * receives only `say`; the room turns that said intent into the assigned
 * summary and supplies its recipient and range.
 *
 * The driver binds the tools to one activation, and an executor adapts each
 * `BoundTool` to its harness: a Pi tool, an MCP tool, or a tool that a bridge
 * serves over a socket. The executor gives each call its id, and the id is
 * the idempotency key of the commit. The rules for what the model reads, and
 * for when the activation ends, live here once.
 */

import type { ToolContext, ToolResult, ToolUpdate } from '../bundle.ts';
import { invokeTool } from '../compose-tool.ts';
import { DISMISS, RECALL, SAY, SCHEDULE, SEAT, UNSEAT } from '../define.ts';
import type { ActivationView, CommitResult, Intent, RoomProtocol, Unchanged } from '../protocol.ts';
import { renderLine } from '../record.ts';
import { parseRoomUri, REF_LIMITS, roomUri } from '../refs.ts';
import type { AgentDefinition, Message, Seq } from '../types.ts';
import type { BoundTool, BoundToolResult, StepSink } from './contract.ts';
import { refusal, summaryToolDescription } from './render.ts';
import { ownEntryAfter } from './rules.verified.ts';

/** The name of the MCP server that serves the room tools to a harness. */
export const ROOM_SERVER = 'ambion';

/** What every room tool reaches: the activation and the room. */
export interface RoomToolBinding {
	readonly id: string;
	/** The room calls the tools make: a commit, and the view of one message. */
	readonly room: Pick<RoomProtocol, 'view' | 'commit'>;
	/** The freshness boundary of an ordinary say. The tools read it at each call. */
	readonly readThrough: Seq;
	/** An accepted ordinary say confirms the activation read the record through here. */
	acknowledgeThrough(seq: Seq): void;
	/** The result of call `call` carries the record through `seq` to the model. */
	resultExpected(call: string, seq: Seq): void;
	/** The result of the `compose` call `compose` shows the results of the nested calls `calls`. */
	reported(compose: string, calls: readonly string[]): void;
	/** The entry `seq` is the activation's own act, so the record after `after` through it counts as read. */
	ownEntry(after: Seq, seq: Seq): void;
	/** End the activation. */
	cut(): void;
}

/** A summary activation: its person, everyone it addresses, and how many it has answered. */
interface Summarizing {
	readonly person: string;
	readonly people: readonly string[];
	answered: number;
}

interface SayArgs {
	to?: string;
	text: string;
	refs?: string[];
}

interface ScheduleArgs {
	delaySeconds: number;
	text: string;
	refs?: string[];
}

/**
 * The room's answer to the commit of each result. Only the scripted executor
 * of `@ambionframework/ambion/testing` reads it, through `answerOf`. A
 * script branches on a short answer, such as `delivered`, `missed`, or
 * `stale: <why>`. The result holds only the text that a model reads, and the
 * scripted executor makes no call to the room, so it cannot read the answer
 * through the executor contract. The hosting entry does not export
 * `answerOf`. The map holds each result weakly, so it keeps no entry past
 * its result.
 */
const answers = new WeakMap<BoundToolResult, CommitResult>();

/** The result of a commit, with the room's answer kept beside it. */
function answered(result: BoundToolResult, response: CommitResult): BoundToolResult {
	answers.set(result, response);
	return result;
}

/** The room's answer to the commit that gave `result`, or nothing when the tool committed nothing. */
export function answerOf(result: BoundToolResult): CommitResult | undefined {
	return answers.get(result);
}

const text = (value: string, isError = false): BoundToolResult => ({
	content: [{ type: 'text', text: value }],
	...(isError ? { isError: true as const } : {}),
});

/** The tools an activation holds from the room, by its purpose. */
export function roomTools(view: ActivationView, binding: RoomToolBinding): BoundTool[] {
	const { purpose } = view.spec;
	if (purpose.kind === 'summarize') {
		const closing = { person: purpose.person, people: purpose.people, answered: 0 };
		return [sayTool(binding, closing)];
	}
	const tools = [
		sayTool(binding),
		scheduleTool(view.spec.seat, binding),
		seatingTool(binding, 'seated'),
		seatingTool(binding, 'unseated'),
		dismissTool(binding),
		recallTool(view.context.name, binding),
	];
	// Any of them can run in a `compose` call, which then shows the results of the nested calls.
	return tools.map((tool) => ({
		...tool,
		reported: (compose, calls) => binding.reported(compose, calls),
	}));
}

/**
 * The agent's own tools, as room tools. A summary activation holds none. Each
 * call reads the view of the pass that runs it, so the room and the open
 * exchange it names are current. `room` holds the room tools of the
 * activation, which a `compose` call binds. A tool that throws gives the model its
 * message as an error result.
 */
export function agentTools(
	view: ActivationView,
	agent: AgentDefinition,
	signal: AbortSignal,
	sink: StepSink,
	current: () => ActivationView,
	room: readonly BoundTool[],
): BoundTool[] {
	if (view.spec.purpose.kind === 'summarize') return [];
	return agent.executor.tools.map((one) => ({
		name: one.name,
		description: one.description,
		parameters: one.parameters,
		run: async (args, call) => {
			const running = current();
			try {
				const ctx = toolContext(agent, running, call, signal);
				const value = await invokeTool(one, args, ctx, (step) => sink.record(step), room);
				return toolResultOf(value);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	}));
}

/**
 * The context an agent's tool receives for one call: the agent, the call, and
 * full provenance. It holds no step sink. `invokeTool` hands the sink and the
 * room tools of the activation to the `compose` tool, and to no other tool.
 */
export function toolContext(
	agent: AgentDefinition,
	view: ActivationView,
	call: string,
	signal: AbortSignal | undefined,
	onUpdate?: ToolUpdate,
): ToolContext {
	const exchange = view.context.exchange;
	return Object.freeze({
		agent: { name: agent.name, identity: agent.identity },
		signal,
		callId: call,
		...(onUpdate === undefined ? {} : { onUpdate }),
		room: view.context.name,
		activation: view.spec.id,
		...(exchange === undefined ? {} : { exchange: Object.freeze({ ...exchange }) }),
		...(view.deadline === undefined ? {} : { deadline: view.deadline }),
	});
}

/** What an agent's tool returned, as the model reads it: its content only. */
function toolResultOf(value: string | ToolResult): BoundToolResult {
	if (typeof value === 'string') return text(value);
	return { content: value.content.map((part) => ({ ...part })) };
}

/** What the model reads for a commit the room answered. */
function landed(binding: RoomToolBinding, response: CommitResult): BoundToolResult {
	if ('committed' in response || 'unchanged' in response) return text(landedLine(response));
	if ('refused' in response) return text(response.refused, true);
	binding.cut();
	if ('unknown' in response) {
		// The message may already be on the record, so the activation ends here. A
		// second say under a new key would land the same message twice.
		return ended('The room did not confirm your message, and it may already hold it.');
	}
	const why = 'stale' in response ? response.stale : 'the room moved';
	return ended(`Your activation ended: ${why}.`);
}

/**
 * What the model reads for a commit the room took: what landed, and its seq,
 * so the agent can cite its own message. A seating change the record
 * already holds says so.
 */
function landedLine(response: { committed: Message } | { unchanged: Unchanged }): string {
	if ('unchanged' in response) {
		const { unchanged } = response;
		if (unchanged.kind === 'dismissed') return `#${unchanged.message} no longer waits`;
		return unchanged.kind === 'seated'
			? `${unchanged.name} is already seated. Seating it again does not activate it. Read its mark in the roster: marked "named only", it gets the request through say with to set to ${unchanged.name}; with no mark or marked "watches arrivals", it already has the request.`
			: `${unchanged.name} is not seated`;
	}
	const message = response.committed;
	if (message.kind === 'seated' || message.kind === 'unseated')
		return `${message.kind} ${message.subject} (#${message.seq})`;
	const to = 'to' in message && message.to !== undefined ? ` to ${message.to}` : '';
	return `said #${message.seq}${to}`;
}

/** The line of a say the room scheduled: its seq, and when it returns. */
function scheduledLine(message: Message): string {
	const delaySeconds = message.kind === 'said' ? (message.delaySeconds ?? 0) : 0;
	const due = new Date(Date.parse(message.at) + delaySeconds * 1000).toISOString();
	return `scheduled #${message.seq}: the room wakes you with this message at ${due}`;
}

/** The result that tells the model its activation has ended. */
function ended(why: string): BoundToolResult {
	return { ...text(`${why} This activation is over.`, true), terminate: true };
}

/** The refs a say cites: each trimmed, none empty. */
function refsOf(cited: readonly string[] | undefined) {
	const refs = (cited ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0);
	return refs.length > 0 ? { refs } : {};
}

/** The intent a say stands for: its text and refs trimmed, and no empty field. */
function saidBy(args: SayArgs): Intent {
	const to = args.to?.trim();
	return {
		kind: 'said',
		...(to ? { to } : {}),
		text: args.text.trim(),
		...refsOf(args.refs),
	};
}

/** The intent a schedule stands for: a say to the seat itself, with `delaySeconds`. */
function scheduledBy(seat: string, args: ScheduleArgs): Intent {
	return {
		kind: 'said',
		to: seat,
		text: args.text.trim(),
		...refsOf(args.refs),
		delaySeconds: args.delaySeconds,
	};
}

/** The tool that speaks for a respond activation or publishes its close. */
function sayTool(binding: RoomToolBinding, closing?: Summarizing): BoundTool {
	return {
		name: SAY.name,
		description:
			closing === undefined
				? SAY.description
				: summaryToolDescription(closing.person, closing.people),
		parameters: SAY.parameters,
		run: (args, call) => say(binding, args as SayArgs, call, closing),
	};
}

async function say(
	binding: RoomToolBinding,
	args: SayArgs,
	call: string,
	closing: Summarizing | undefined,
): Promise<BoundToolResult> {
	const response = await binding.room.commit({
		activation: binding.id,
		key: call,
		...(closing === undefined ? { readThrough: binding.readThrough } : {}),
		intent: saidBy(args),
	});
	return answered(sayResult(binding, call, response, closing), response);
}

/** What the model reads for a say the room answered. */
function sayResult(
	binding: RoomToolBinding,
	call: string,
	response: CommitResult,
	closing: Summarizing | undefined,
): BoundToolResult {
	if ('missed' in response) return missedSay(binding, call, response.missed);
	if ('committed' in response) accepted(binding, response.committed, closing);
	const result = landed(binding, response);
	if (closing === undefined || result.isError) return result;
	// The summary activation ends after the last recipient has a message.
	return closing.answered >= closing.people.length ? { ...result, terminate: true } : result;
}

/**
 * The tool that schedules a say to the seat itself. The room takes a
 * scheduled say at any position. When the record moved past the read
 * position, the result carries the messages the say landed past.
 */
function scheduleTool(seat: string, binding: RoomToolBinding): BoundTool {
	return {
		name: SCHEDULE.name,
		description: SCHEDULE.description,
		parameters: SCHEDULE.parameters,
		run: async (args, call) => {
			const response = await binding.room.commit({
				activation: binding.id,
				key: call,
				readThrough: binding.readThrough,
				intent: scheduledBy(seat, args as ScheduleArgs),
			});
			if (!('committed' in response)) return answered(landed(binding, response), response);
			const result = scheduleResult(binding, call, response.committed, response.unread ?? []);
			return answered(result, response);
		},
	};
}

/**
 * What the model reads for a scheduled say. With no message landed past it,
 * the say confirms the read position. Otherwise the result carries those
 * messages, and the model reads the record through the say when it reads
 * the result.
 */
function scheduleResult(
	binding: RoomToolBinding,
	call: string,
	message: Message,
	unread: readonly Message[],
): BoundToolResult {
	const line = scheduledLine(message);
	if (unread.length === 0) {
		binding.acknowledgeThrough(message.seq);
		return text(line);
	}
	binding.resultExpected(call, message.seq);
	return {
		...text([`${line}. New on the record before it:`, ...unread.map(renderLine)].join('\n')),
		carriesRecord: true,
	};
}

/** A say the room took. An ordinary say confirms the read position. A closing say counts as an answer. */
function accepted(
	binding: RoomToolBinding,
	message: Message,
	closing: Summarizing | undefined,
): void {
	if (closing !== undefined) {
		closing.answered += 1;
	} else if (message.kind === 'said') {
		binding.acknowledgeThrough(message.seq);
	}
}

/** A say the room refused because the record moved. The result carries the missed lines. */
function missedSay(
	binding: RoomToolBinding,
	call: string,
	missed: readonly Message[],
): BoundToolResult {
	// A closing say states no read position, so only an ordinary say reaches here.
	binding.resultExpected(call, missed.at(-1)?.seq ?? binding.readThrough);
	const result = text(
		refusal(
			'Not delivered: the room moved while you were speaking. New on the record:',
			[...missed],
			'Read it, then call say again with your message unless the new messages already say it or make it unnecessary.',
		),
		true,
	);
	return { ...result, carriesRecord: true };
}

/** The tool that seats or removes one agent. */
function seatingTool(binding: RoomToolBinding, kind: 'seated' | 'unseated'): BoundTool {
	const spec = kind === 'seated' ? SEAT : UNSEAT;
	return {
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		run: async (args, call) => {
			const readThrough = binding.readThrough;
			const response = await binding.room.commit({
				activation: binding.id,
				key: call,
				readThrough,
				intent: { kind, name: (args as { name: string }).name.trim() },
			});
			if ('committed' in response) ownEntry(binding, readThrough, response);
			return answered(landed(binding, response), response);
		},
	};
}

/**
 * A seat or a dismissal that landed is the own act of the activation. With
 * no message of another participant between the read position and the entry, the
 * record through the entry counts as read. Otherwise the lines wait for a read.
 */
function ownEntry(
	binding: RoomToolBinding,
	readThrough: Seq,
	response: { committed: Message; unread?: Message[] },
): void {
	const { seq } = response.committed;
	// `seq` is a seq of the journal, so it is at least 1.
	binding.ownEntry(ownEntryAfter(readThrough, seq, (response.unread ?? []).length), seq);
}

/** The room tool that dismisses one scheduled say of the seat, by its seq. */
function dismissTool(binding: RoomToolBinding): BoundTool {
	return {
		name: DISMISS.name,
		description: DISMISS.description,
		parameters: DISMISS.parameters,
		run: async (args, call) => {
			const message = (args as { message: number }).message;
			const readThrough = binding.readThrough;
			const response = await binding.room.commit({
				activation: binding.id,
				key: call,
				readThrough,
				intent: { kind: 'dismissed', message },
			});
			if ('committed' in response) {
				ownEntry(binding, readThrough, response);
				return answered(text(`dismissed #${message}`), response);
			}
			return answered(landed(binding, response), response);
		},
	};
}

/**
 * The room tool that reads messages of this room by URI. It gives one line
 * for each distinct ref, in the order given: the message, or why the room
 * gave none. A ref that finds no message makes the call an error. It reads
 * what the view of the activation may read, commits nothing, and moves no
 * read position: a recalled message is old.
 */
function recallTool(room: string, binding: RoomToolBinding): BoundTool {
	return {
		name: RECALL.name,
		description: RECALL.description,
		parameters: RECALL.parameters,
		run: async (args) => {
			const refs = recallRefs(args);
			if (refs === undefined)
				return text(
					`refs must be 1 to ${REF_LIMITS.count} messages of this room: a seq as #12, or a URI.`,
					true,
				);
			const lines: { found: boolean; line: string }[] = [];
			for (const ref of refs) lines.push(await recallLine(binding, room, ref));
			const missed = lines.some((one) => !one.found);
			return text(lines.map((one) => one.line).join('\n'), missed);
		},
	};
}

/** The refs of a `recall` call, trimmed and each once, or nothing when the schema refuses them. */
function recallRefs(args: unknown): string[] | undefined {
	const refs: unknown = (args as { refs?: unknown }).refs;
	if (!Array.isArray(refs) || refs.length === 0 || refs.length > REF_LIMITS.count) return undefined;
	if (!refs.every((ref): ref is string => typeof ref === 'string')) return undefined;
	return [...new Set(refs.map((ref) => ref.trim()))];
}

/** The line of one ref: the message it names, or why the room gave none. */
async function recallLine(
	binding: RoomToolBinding,
	room: string,
	ref: string,
): Promise<{ found: boolean; line: string }> {
	const named = shortRef(room, ref) ?? parseRoomUri(ref);
	const missed = (why: string) => ({ found: false, line: `${ref}: ${why}` });
	if (named?.message === undefined)
		return missed(
			`not a message ref. Give the seq as #12, or the URI ${roomUri(room)}/message/<seq>.`,
		);
	if (named.room !== room) return missed('names another room. recall reads this room alone.');
	const message = await messageAt(binding, named.message);
	return message === undefined
		? missed(
				`no message at #${named.message} on the record you may read. Take the seq from a record line or a ref.`,
			)
		: { found: true, line: renderLine(message) };
}

/** A seq of this room, as the record shows it (`#12`) or bare (`12`), or nothing. */
function shortRef(room: string, ref: string): { room: string; message: Seq } | undefined {
	const seq = /^#?([1-9][0-9]*)$/.exec(ref)?.[1];
	const message = Number(seq);
	return seq !== undefined && Number.isSafeInteger(message) ? { room, message } : undefined;
}

/**
 * The message at `seq`, from the view of that one message. The room reads it
 * under the purpose alone, so a message below the window of the activation
 * still answers. A view that holds none means no message.
 */
async function messageAt(binding: RoomToolBinding, seq: Seq): Promise<Message | undefined> {
	const response = await binding.room.view(binding.id, seq);
	if (!('view' in response)) return undefined;
	return response.view.context.messages.find((message) => message.seq === seq);
}
