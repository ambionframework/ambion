/** The authority one recorded activation grants to its seat. */

import type { Seq } from '../types.ts';
import type { ActivationSpec } from '../wire.ts';
import type { RoomState } from './fold.ts';
import { parseId } from './lease.ts';

/** Compile the recorded cause and current composition into one activation authority. */
export function activationSpec(id: string, state: RoomState): ActivationSpec | undefined {
	const parsed = parseId(id);
	if (parsed === undefined) return undefined;
	const seated = state.roster.find((candidate) => candidate.name === parsed.seat);
	if (seated === undefined) return undefined;
	const identity = { id, seat: parsed.seat, attempt: parsed.attempt };
	if (parsed.cause === 'message') {
		if (!state.messages.some((message) => message.seq === parsed.position)) return undefined;
		return {
			...identity,
			cause: 'message',
			through: state.lastSeq,
			grant: { kind: 'say', tool: 'say' },
		};
	}
	const tool = seated.role?.answers[parsed.cause];
	if (tool === undefined) return undefined;
	return parsed.cause === 'opened'
		? opened(identity, parsed.position, tool, state)
		: closed(identity, parsed.position, tool, state);
}

function opened(
	identity: { id: string; seat: string; attempt: number },
	position: Seq,
	tool: string,
	state: RoomState,
): ActivationSpec | undefined {
	const question = state.messages.find((message) => message.seq === position);
	if (
		question?.kind !== 'said' ||
		(state.exchange?.from !== position && !state.closes.some((close) => close.from === position))
	)
		return undefined;
	return {
		...identity,
		cause: 'opened',
		through: state.lastSeq,
		opening: { person: question.from, from: question.seq, limit: state.reserve.length },
		grant: grant(tool, 'seat', 'seat'),
	};
}

function closed(
	identity: { id: string; seat: string; attempt: number },
	position: Seq,
	tool: string,
	state: RoomState,
): ActivationSpec | undefined {
	const close = state.closes.find(
		(candidate) => candidate.through === position && candidate.wakes?.[0] === identity.seat,
	);
	if (close === undefined) return undefined;
	const roomGrant = grant(tool, 'summarise', 'summary');
	return {
		...identity,
		cause: 'closed',
		through: roomGrant.kind === 'say' ? state.lastSeq : close.through,
		closing: { person: close.owner, from: close.from, through: close.through },
		grant: roomGrant,
	};
}

function grant<K extends 'seat' | 'summary', B extends 'seat' | 'summarise'>(
	tool: string,
	builtin: B,
	kind: K,
):
	| { readonly kind: K; readonly tool: B }
	| { readonly kind: 'say'; readonly tool: 'say' }
	| { readonly kind: 'none' }
	| { readonly kind: 'custom'; readonly tool: string } {
	if (tool === builtin) return { kind, tool: builtin };
	if (tool === 'say') return { kind: 'say', tool: 'say' };
	if (tool === 'seat' || tool === 'summarise') return { kind: 'none' };
	return { kind: 'custom', tool };
}
