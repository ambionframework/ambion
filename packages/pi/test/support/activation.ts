/** One activation built by hand over the core state, with no runner and no room around it. */
import type { AgentDefinition, RoomNotification } from '@ambionframework/ambion';
import type {
	ActivationOpener,
	ActivationView,
	CommitRequest,
	CommitResult,
	RoomProtocol,
	RoomTool,
	StepSink,
} from '@ambionframework/ambion/hosting';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { ActivationState } from '../../../ambion/src/execution/activation.ts';
import { noTrace } from './trace.ts';

/** A room that answers every call stale. */
export const unusedRoom: RoomProtocol = {
	view: async () => ({ stale: 'unused' }),
	commit: async () => ({ stale: 'unused' }),
	lease: async () => ({ stale: 'unused' }),
};

/** A room that records each commit and answers it with the next prepared result. */
export function roomThatCommits(
	commits: CommitRequest[],
	answer: (request: CommitRequest) => CommitResult,
): RoomProtocol {
	return {
		...unusedRoom,
		commit: async (request) => {
			commits.push(request);
			return answer(request);
		},
	};
}

/** The core state of one activation over `executor`, as the driver opens it. */
export function stateOf(
	opener: ActivationOpener,
	definition: AgentDefinition,
	options: {
		id?: string;
		room?: RoomProtocol;
		emit?: (event: RoomNotification) => void;
		trace?: StepSink;
	} = {},
): ActivationState {
	return new ActivationState(opener, {
		id: options.id ?? 'message:1:worker:1',
		room: options.room ?? unusedRoom,
		definition,
		emit: options.emit ?? (() => {}),
		trace: options.trace ?? noTrace,
	});
}

/**
 * The core state of one activation over `room`, and the room tools that it
 * binds on a first pass over `view`. The pass runs no model.
 */
export async function boundActivation(
	id: string,
	definition: AgentDefinition,
	room: RoomProtocol,
	view: ActivationView,
): Promise<{ state: ActivationState; tools: readonly RoomTool[] }> {
	let tools: readonly RoomTool[] = [];
	const opener = () => ({
		pass: async (pass: { readonly tools: readonly RoomTool[] }) => {
			tools = pass.tools;
			return { failed: false };
		},
	});
	const state = new ActivationState(opener, {
		id,
		room,
		definition,
		emit: () => {},
		trace: noTrace,
	});
	await state.pass({ kind: 'view', view });
	return { state, tools };
}

/** The view of one activation purpose over an empty room. */
export function viewFor(
	purpose: ActivationView['spec']['purpose'],
	through = purpose.kind === 'summarize' ? purpose.through : 0,
): ActivationView {
	return {
		spec: { id: 'activation', seat: 'worker', attempt: 1, purpose },
		through,
		context: { name: 'room', now: 0, participants: [], messages: [], reserve: [] },
	};
}

/**
 * The part of the harness api that a tool of the executor reads: the call id
 * and the output sink. The harness gives every other member to a tool that
 * runs inside a conversation, and these tools use none of them.
 */
export function toolApi(callId: string, output: string[] = []): ToolExecutionApi {
	return {
		callId,
		output: (chunk: string | Uint8Array) => output.push(String(chunk)),
	} as unknown as ToolExecutionApi;
}
