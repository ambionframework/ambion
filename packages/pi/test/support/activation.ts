/** One Pi activation built by hand, with no runner and no room around it. */
import type { AgentDefinition, RoomNotification } from '@ambionframework/ambion';
import type {
	ActivationView,
	CommitRequest,
	CommitResult,
	RoomProtocol,
} from '@ambionframework/ambion/hosting';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { noTrace } from '../../../ambion/test/support/trace.ts';
import { Activation } from '../../src/executor.ts';
import { stubModel } from '../../src/services.ts';

const unused = () => {
	throw new Error('unused');
};

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

export function activationFor(
	id: string,
	definition: AgentDefinition,
	options: {
		stream?: StreamFn;
		emit?: (event: RoomNotification) => void;
	} = {},
): Activation {
	return new Activation(
		{ id, room: unusedRoom, emit: options.emit ?? (() => {}), trace: noTrace },
		{
			definition,
			model: stubModel,
			stream: options.stream ?? unused,
			now: () => 0,
		},
	);
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
