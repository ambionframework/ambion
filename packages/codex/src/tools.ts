/**
 * The room tools bound to one activation, and the agent's own tools, as
 * plain handlers that the bridge serves over the local socket.
 *
 * Every ordinary activation can speak, seat an agent, or remove an agent.
 * A closing activation receives only `say`; the room turns that said intent
 * into the assigned summary and supplies its recipient and range.
 *
 * Codex sends no echo of the input it read. The binding is synchronous: an
 * accepted say confirms the read position, and a `missed` answer carries
 * the missed lines to the model in the same result, so the read position
 * moves to the last of them at once.
 */
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AmbionTool, Message, ToolResult } from '@ambionframework/ambion';
import type {
	ActivationView,
	AgentDefinition,
	CommitResult,
	Intent,
	RoomProtocol,
	Seq,
} from '@ambionframework/ambion/hosting';
import {
	refusal,
	SAY,
	SEAT,
	summaryToolDescription,
	UNSEAT,
} from '@ambionframework/ambion/hosting';
import type { TSchema } from 'typebox';
import type { Result, ToolSpec } from './wire.ts';

/** What every room tool reaches: the activation and the room. */
export interface Binding {
	readonly id: string;
	readonly room: RoomProtocol;
	readonly readThrough: Seq;
	/** Aborts when the activation is cut. */
	readonly signal: AbortSignal;
	/** The model read the record through `seq`. */
	acknowledgeThrough(seq: Seq): void;
	/** The id the model gave this call. A call the stream did not name gets a fresh id. */
	callId(tool: string): string;
	abort(): void;
}

/** The workspace paths the agent changed since its last say. */
export interface Changed {
	peek(): readonly string[];
	clear(): void;
}

/** One tool the server lists: its spec, and what runs when the model calls it. */
export interface RoomTool {
	readonly spec: ToolSpec;
	run(args: unknown): Promise<Result>;
}

const text = (value: string, isError = false): Result => ({
	content: [{ type: 'text', text: value }],
	...(isError ? { isError } : {}),
});

/** The JSON Schema of a TypeBox value, as plain data. */
function schemaOf(schema: TSchema): Record<string, unknown> {
	return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

/** What the model reads for a commit the room answered. */
function landed(binding: Binding, response: CommitResult): Result {
	if ('committed' in response || 'unchanged' in response) return text('delivered');
	if ('refused' in response) return text(response.refused, true);
	if ('unknown' in response) {
		// The message may already be on the record, so the activation ends here. A
		// second say under a new key would land the same message twice.
		binding.abort();
		return text(
			'The room did not confirm your message, and it may already hold it. This turn is over.',
			true,
		);
	}
	binding.abort();
	const why = 'stale' in response ? response.stale : 'the room moved';
	return text(`Your turn ended: ${why}. This turn is over.`, true);
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
}

/** A ref is one absolute URI with a scheme. Codex reports a changed file as a path, so a path becomes a `file:` URI. */
export function refOf(value: string): string {
	const ref = value.trim();
	return isAbsolute(ref) ? pathToFileURL(ref).href : ref;
}

/** The intent a say stands for: its text and refs trimmed, paths as `file:` URIs, and no empty field. */
function saidBy(args: SayArgs, changed: readonly string[]): Intent {
	const to = args.to?.trim();
	const cited = [...(args.refs ?? []), ...changed]
		.map(refOf)
		.filter((ref) => ref.length > 0);
	const refs = [...new Set(cited)];
	return {
		kind: 'said',
		...(to ? { to } : {}),
		text: args.text.trim(),
		...(refs.length > 0 ? { refs } : {}),
	};
}

async function say(
	binding: Binding,
	changed: Changed,
	args: SayArgs,
	closing?: Closing,
): Promise<Result> {
	const call = binding.callId(SAY.name);
	const response = await binding.room.commit({
		activation: binding.id,
		key: call,
		...(closing === undefined ? { readThrough: binding.readThrough } : {}),
		intent: saidBy(args, closing === undefined ? changed.peek() : []),
	});
	if ('missed' in response) return missedSay(binding, response.missed, closing);
	if ('committed' in response) accepted(binding, changed, response.committed, closing);
	return landed(binding, response);
}

/** A say the room took. An ordinary say confirms the read position and cites the changed paths. */
function accepted(
	binding: Binding,
	changed: Changed,
	message: Message,
	closing: Closing | undefined,
): void {
	if (closing !== undefined) {
		closing.answered += 1;
	} else if (message.kind === 'said') {
		changed.clear();
		binding.acknowledgeThrough(message.seq);
	}
}

/** A say the room refused because the record moved. The model reads the missed lines now. */
function missedSay(
	binding: Binding,
	missed: readonly Message[],
	closing: Closing | undefined,
): Result {
	if (closing === undefined) binding.acknowledgeThrough(missed.at(-1)?.seq ?? binding.readThrough);
	return text(
		refusal(
			'Not delivered — the room moved while you were speaking. New on the record:',
			[...missed],
			'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
		),
		true,
	);
}

/** The tool that speaks for an ordinary activation or publishes its close. */
function sayTool(binding: Binding, changed: Changed, closing?: Closing): RoomTool {
	const description =
		closing === undefined
			? 'Speak on the record. Omit `to` to address the room; set `to` to address a participant directly. Put the URI of anything the message cites in `refs`.'
			: summaryToolDescription(closing.person, closing.people);
	return {
		spec: { name: SAY.name, description, inputSchema: schemaOf(SAY.parameters) },
		run: (args) => say(binding, changed, args as SayArgs, closing),
	};
}

/** The tool that seats or removes one agent. */
function membershipTool(binding: Binding, kind: 'seated' | 'unseated'): RoomTool {
	const seat = kind === 'seated';
	const name = seat ? SEAT.name : UNSEAT.name;
	return {
		spec: {
			name,
			description: seat
				? 'Seat one agent from the reserve. It joins the room and reads the record.'
				: "Remove one seated agent from the room. A fixed seat, such as the summary writer's, stays.",
			inputSchema: schemaOf((seat ? SEAT : UNSEAT).parameters),
		},
		run: async (args) => {
			const response = await binding.room.commit({
				activation: binding.id,
				key: binding.callId(name),
				intent: { kind, name: (args as { name: string }).name.trim() },
			});
			return landed(binding, response);
		},
	};
}

/** What a domain tool returned, as the model reads it. */
function resultOf(value: string | ToolResult): Result {
	if (typeof value === 'string') return text(value);
	return { content: value.content.map((part) => ({ ...part })) };
}

/**
 * A tool from a normalized tool. The tool reads the view of the pass that
 * runs it, so the room and the open exchange it names are current. A tool
 * that throws gives the model its message as an error result.
 */
function domainTool(
	one: AmbionTool,
	agent: AgentDefinition,
	binding: Binding,
	current: () => ActivationView,
): RoomTool {
	return {
		spec: { name: one.name, description: one.description, inputSchema: schemaOf(one.parameters) },
		run: async (args) => {
			const view = current();
			const exchange = view.context.exchange;
			try {
				const params = one.prepareArguments === undefined ? args : one.prepareArguments(args);
				const value = await one.invoke(
					params,
					Object.freeze({
						agent: { name: agent.name, identity: agent.identity },
						signal: binding.signal,
						callId: binding.callId(one.name),
						room: view.context.name,
						activation: view.spec.id,
						...(exchange === undefined
							? {}
							: { exchange: Object.freeze({ owner: exchange.owner, from: exchange.from }) }),
					}),
				);
				return resultOf(value);
			} catch (error) {
				return text(error instanceof Error ? error.message : String(error), true);
			}
		},
	};
}

/** The tools an activation holds, by its purpose. */
export function roomTools(
	view: ActivationView,
	agent: AgentDefinition,
	binding: Binding,
	changed: Changed,
	current: () => ActivationView = () => view,
): RoomTool[] {
	const { purpose } = view.spec;
	if (purpose.kind === 'summarize') {
		return [
			sayTool(binding, changed, { person: purpose.person, people: purpose.people, answered: 0 }),
		];
	}
	return [
		sayTool(binding, changed),
		membershipTool(binding, 'seated'),
		membershipTool(binding, 'unseated'),
		...agent.executor.tools.map((one) => domainTool(one, agent, binding, current)),
	];
}
