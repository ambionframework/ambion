/** The room tools bound to one activation and the agent's own tools.
 *
 * Every ordinary activation can speak, seat an agent, or remove an agent.
 * A closing activation receives only `say`; the room turns that said intent
 * into the assigned summary and supplies its recipient and range.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import { SAY, SEAT, UNSEAT } from '../define.ts';
import type { ActivationView, CommitResult, Intent, SeatRoom } from '../protocol.ts';
import type { AgentDefinition, AmbionTool, Message } from '../types.ts';
import type { Activation } from './activation.ts';
import { refusal } from './render.ts';
import { summaryToolDescription } from './summary.ts';

/** A Pi tool from a normalized tool. */
function toPiTool(tool: AmbionTool, agent: AgentDefinition): AgentTool<TSchema, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
		...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
		execute: async (toolCallId, params, signal, onUpdate) => {
			const result = await tool.invoke(params, {
				agent: { name: agent.name, identity: agent.identity },
				signal,
				callId: toolCallId,
				onUpdate,
			});
			return typeof result === 'string'
				? { content: [{ type: 'text', text: result }], details: {} }
				: result;
		},
	};
}

/** What a write tool returns when the room accepted or already held it. */
function delivered(): AgentToolResult<Record<string, never>> {
	return { content: [{ type: 'text', text: 'delivered' }], details: {} };
}

/** What every room tool reaches: the activation and the room. */
export interface Binding {
	readonly activation: Activation;
	readonly room: SeatRoom;
	landed(response: CommitResult): AgentToolResult<Record<string, never>>;
}

export function binding(activation: Activation, room: SeatRoom): Binding {
	return {
		activation,
		room,
		landed(response) {
			return landResponse(activation, response);
		},
	};
}

function landResponse(
	activation: Activation,
	response: CommitResult,
): AgentToolResult<Record<string, never>> {
	if ('committed' in response) return delivered();
	if ('unchanged' in response) return delivered();
	if ('refused' in response) throw new Error(response.refused);
	if ('missed' in response) throw new Error('The room moved. Read what landed, then decide again.');
	activation.abort();
	return standDown(`Your turn ended: ${response.stale}.`) as AgentToolResult<Record<string, never>>;
}

/** The tool that speaks for an ordinary activation or publishes its close. */
function sayTool(bound: Binding, closingPerson?: string): AgentTool {
	return {
		...SAY,
		label: SAY.name,
		description:
			closingPerson === undefined
				? 'Speak on the record. Omit `to` to address the room; set `to` to address a participant directly.'
				: summaryToolDescription(closingPerson),
		execute: async (toolCallId, rawParams) => say(bound, toolCallId, rawParams, closingPerson),
	};
}

async function say(
	bound: Binding,
	toolCallId: string,
	rawParams: unknown,
	closingPerson?: string,
): Promise<AgentToolResult<Record<string, never>>> {
	const params = rawParams as { to?: string; text: string };
	const text = params.text.trim();
	const to = params.to?.trim() ? params.to.trim() : undefined;
	const intent: Intent = { kind: 'said', ...(to === undefined ? {} : { to }), text };
	const response = await bound.room.commit({
		activation: bound.activation.id,
		key: toolCallId,
		...(closingPerson === undefined ? { readThrough: bound.activation.readThrough } : {}),
		intent,
	});
	if ('missed' in response) return missedSay(bound, toolCallId, response, closingPerson);
	if (closingPerson === undefined) acknowledgeSay(bound, response);
	const result = bound.landed(response);
	return closingPerson === undefined ? result : { ...result, terminate: true };
}

function acknowledgeSay(bound: Binding, response: CommitResult): void {
	if ('committed' in response && response.committed.kind === 'said') {
		bound.activation.acknowledgeThrough(response.committed.seq);
	}
}

function missedSay(
	bound: Binding,
	toolCallId: string,
	response: Extract<CommitResult, { missed: readonly Message[] }>,
	closingPerson: string | undefined,
): never {
	if (closingPerson === undefined) {
		bound.activation.toolResultExpected(
			toolCallId,
			response.missed.at(-1)?.seq ?? bound.activation.readThrough,
		);
	}
	throw new Error(
		refusal(
			'Not delivered — the room moved while you were speaking. New on the record:',
			response.missed,
			'Speak again only if your reply still adds something the room has not heard; otherwise end your turn.',
		),
	);
}

/** The tool that seats one supplied agent. */
function seatTool(bound: Binding): AgentTool {
	return membershipTool(bound, SEAT, 'seated');
}

/** The tool that removes one seated agent. */
function unseatTool(bound: Binding): AgentTool {
	return membershipTool(bound, UNSEAT, 'unseated');
}

function membershipTool(
	bound: Binding,
	tool: typeof SEAT | typeof UNSEAT,
	kind: 'seated' | 'unseated',
): AgentTool {
	return {
		...tool,
		label: tool.name,
		description:
			kind === 'seated'
				? 'Seat one agent from the reserve. It joins the room and reads the record.'
				: 'Remove one seated agent from the room.',
		execute: async (toolCallId, rawParams) => {
			const name = (rawParams as { name: string }).name.trim();
			const intent: Intent = { kind, name };
			const response = await bound.room.commit({
				activation: bound.activation.id,
				key: toolCallId,
				intent,
			});
			return bound.landed(response);
		},
	};
}

/** What an activation holds from its purpose. */
export function toolsFor(view: ActivationView, def: AgentDefinition, held: Binding): AgentTool[] {
	if (view.spec.purpose.kind === 'summarize') {
		return [sayTool(held, view.spec.purpose.person)];
	}
	return [
		sayTool(held),
		seatTool(held),
		unseatTool(held),
		...def.tools.map((tool) => toPiTool(tool, def)),
	];
}

/** Tell the model loop that its activation has ended. */
function standDown(why: string | undefined): AgentToolResult<Record<string, never>> | undefined {
	if (why === undefined) return undefined;
	return {
		content: [{ type: 'text', text: `${why} This turn is over.` }],
		details: {},
		terminate: true,
	};
}
