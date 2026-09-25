/**
 * The room tools of one activation, and the agent's own tools, in a shape
 * that names no harness.
 *
 * Every ordinary activation can speak, seat an agent, or remove an agent.
 * A closing activation receives only `say`; the room turns that said intent
 * into the assigned summary and supplies its recipient and range.
 *
 * An executor adapts each `RoomTool` to its harness: a Pi tool, an MCP tool,
 * or a tool that a bridge serves over a socket. The executor gives each call
 * its id, and the id is the idempotency key of the commit. The rules for what
 * the model reads, and for when the activation ends, live here once.
 */

import type { AmbionTool, ToolContext, ToolResult, ToolUpdate } from '../bundle.ts';
import { SAY, SEAT, UNSEAT } from '../define.ts';
import {
	type ActivationView,
	type CommitResult,
	classifyCommit,
	type Intent,
	type RoomProtocol,
} from '../protocol.ts';
import type { AgentDefinition, Message, Seq } from '../types.ts';
import { refusal, summaryToolDescription } from './render.ts';

/** One part of what a tool hands back to the model. */
export type RoomToolContent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** What a room tool or an agent tool hands back to the model. */
export interface RoomToolResult {
	readonly content: readonly RoomToolContent[];
	/** The model reads the content as an error. */
	readonly isError?: true;
	/** The activation has nothing more to do: the executor may end its model loop. */
	readonly terminate?: true;
}

/** One tool as a harness lists it, and what runs when the model calls it. */
export interface RoomTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: AmbionTool['parameters'];
	/** Run one call. `call` is the id the harness gave it, and the idempotency key of a commit. */
	run(args: unknown, call: string): Promise<RoomToolResult>;
}

/** What every room tool reaches: the activation and the room. */
export interface RoomToolBinding {
	readonly id: string;
	readonly room: RoomProtocol;
	/** The freshness boundary of an ordinary say. The tools read it at each call. */
	readonly readThrough: Seq;
	/** An accepted ordinary say confirms the activation read the record through here. */
	acknowledgeThrough(seq: Seq): void;
	/** The result of call `call` carries the record through `seq` to the model. */
	resultExpected(call: string, seq: Seq): void;
	/** End the activation. */
	abort(): void;
}

/** What an executor adds to the say of its harness. */
export interface RoomToolOptions {
	/** The refs a say cites, from the refs the model gave, each trimmed and none empty. */
	readonly refs?: (cited: readonly string[]) => readonly string[];
	/** The room took an ordinary say. */
	readonly spoke?: () => void;
}

/** A closing activation: its owner, everyone it addresses, and how many it has answered. */
interface Closing {
	readonly person: string;
	readonly people: readonly string[];
	answered: number;
}

interface SayArgs {
	to?: string;
	text: string;
	refs?: string[];
	after?: number;
}

const text = (value: string, isError = false): RoomToolResult => ({
	content: [{ type: 'text', text: value }],
	...(isError ? { isError: true as const } : {}),
});

/** The tools an activation holds from the room, by its purpose. */
export function roomTools(
	view: ActivationView,
	binding: RoomToolBinding,
	options: RoomToolOptions = {},
): RoomTool[] {
	const { purpose } = view.spec;
	if (purpose.kind === 'summarize') {
		const closing = { person: purpose.person, people: purpose.people, answered: 0 };
		return [sayTool(binding, options, closing)];
	}
	return [
		sayTool(binding, options),
		membershipTool(binding, 'seated'),
		membershipTool(binding, 'unseated'),
	];
}

/**
 * The agent's own tools, as room tools. A closing activation holds none. Each
 * call reads the view of the pass that runs it, so the room and the open
 * exchange it names are current. A tool that throws gives the model its
 * message as an error result.
 */
export function agentTools(
	view: ActivationView,
	agent: AgentDefinition,
	signal: AbortSignal,
	current: () => ActivationView,
): RoomTool[] {
	if (view.spec.purpose.kind === 'summarize') return [];
	return agent.executor.tools.map((one) => ({
		name: one.name,
		description: one.description,
		parameters: one.parameters,
		run: async (args, call) => {
			const running = current();
			try {
				const params = one.prepareArguments === undefined ? args : one.prepareArguments(args);
				const value = await one.invoke(params, toolContext(agent, running, call, signal));
				return toolResultOf(value);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	}));
}

/** The context an agent's tool receives for one call: the agent, the call, and full provenance. */
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
		...(exchange === undefined
			? {}
			: { exchange: Object.freeze({ owner: exchange.owner, from: exchange.from }) }),
		...(view.deadline === undefined ? {} : { deadline: view.deadline }),
	});
}

/** What an agent's tool returned, as the model reads it: its content only. */
function toolResultOf(value: string | ToolResult): RoomToolResult {
	if (typeof value === 'string') return text(value);
	return { content: value.content.map((part) => ({ ...part })) };
}

/** What the model reads for a commit the room answered. */
function landed(binding: RoomToolBinding, response: CommitResult): RoomToolResult {
	const outcome = classifyCommit(response);
	if (outcome.kind === 'delivered') return text('delivered');
	if (outcome.kind === 'refused') return text(outcome.why, true);
	binding.abort();
	if (outcome.kind === 'unknown') {
		// The message may already be on the record, so the activation ends here. A
		// second say under a new key would land the same message twice.
		return ended('The room did not confirm your message, and it may already hold it.');
	}
	const why = outcome.kind === 'ended' ? outcome.why : 'the room moved';
	return ended(`Your turn ended: ${why}.`);
}

/** The result of a say the room scheduled: when it returns. */
function scheduled(response: CommitResult): RoomToolResult | undefined {
	if (!('committed' in response)) return undefined;
	const message = response.committed;
	if (message.kind !== 'said' || message.after === undefined) return undefined;
	const due = new Date(Date.parse(message.at) + message.after * 1000).toISOString();
	return text(`scheduled ${message.seq}: the room gives this say back to you at ${due}`);
}

/** The result that tells the model its activation has ended. */
function ended(why: string): RoomToolResult {
	return { ...text(`${why} This turn is over.`, true), terminate: true };
}

/** The intent a say stands for: its text and refs trimmed, and no empty field. */
function saidBy(args: SayArgs, options: RoomToolOptions): Intent {
	const to = args.to?.trim();
	const trimmed = (args.refs ?? []).map((ref) => ref.trim()).filter((ref) => ref.length > 0);
	const refs = options.refs === undefined ? trimmed : options.refs(trimmed);
	return {
		kind: 'said',
		...(to ? { to } : {}),
		text: args.text.trim(),
		...(refs.length > 0 ? { refs: [...refs] } : {}),
		...(args.after === undefined ? {} : { after: args.after }),
	};
}

/** The tool that speaks for an ordinary activation or publishes its close. */
function sayTool(binding: RoomToolBinding, options: RoomToolOptions, closing?: Closing): RoomTool {
	return {
		name: SAY.name,
		description:
			closing === undefined
				? SAY.description
				: summaryToolDescription(closing.person, closing.people),
		parameters: SAY.parameters,
		run: (args, call) => say(binding, options, args as SayArgs, call, closing),
	};
}

async function say(
	binding: RoomToolBinding,
	options: RoomToolOptions,
	args: SayArgs,
	call: string,
	closing: Closing | undefined,
): Promise<RoomToolResult> {
	const response = await binding.room.commit({
		activation: binding.id,
		key: call,
		...(closing === undefined ? { readThrough: binding.readThrough } : {}),
		intent: saidBy(args, options),
	});
	if ('missed' in response) return missedSay(binding, call, response.missed, closing);
	if ('committed' in response) accepted(binding, options, response.committed, closing);
	const result = scheduled(response) ?? landed(binding, response);
	if (closing === undefined || result.isError) return result;
	// The closing activation ends after the last recipient has a message.
	return closing.answered >= closing.people.length ? { ...result, terminate: true } : result;
}

/** A say the room took. An ordinary say confirms the read position. A closing say counts as an answer. */
function accepted(
	binding: RoomToolBinding,
	options: RoomToolOptions,
	message: Message,
	closing: Closing | undefined,
): void {
	if (closing !== undefined) {
		closing.answered += 1;
	} else if (message.kind === 'said') {
		options.spoke?.();
		binding.acknowledgeThrough(message.seq);
	}
}

/** A say the room refused because the record moved. The result carries the missed lines. */
function missedSay(
	binding: RoomToolBinding,
	call: string,
	missed: readonly Message[],
	closing: Closing | undefined,
): RoomToolResult {
	if (closing === undefined) {
		binding.resultExpected(call, missed.at(-1)?.seq ?? binding.readThrough);
	}
	return text(
		refusal(
			'Not delivered — the room moved while you were speaking. New on the record:',
			[...missed],
			'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
		),
		true,
	);
}

/** The tool that seats or removes one agent. */
function membershipTool(binding: RoomToolBinding, kind: 'seated' | 'unseated'): RoomTool {
	const spec = kind === 'seated' ? SEAT : UNSEAT;
	return {
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		run: async (args, call) => {
			const response = await binding.room.commit({
				activation: binding.id,
				key: call,
				intent: { kind, name: (args as { name: string }).name.trim() },
			});
			return landed(binding, response);
		},
	};
}
