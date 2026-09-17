/** Pure authorization predicates shared by Task hosts and protocol adapters. */

import {
	taskCanCreate as taskCanCreateRule,
	taskCanMutate as taskCanMutateRule,
	taskCanTransition as taskCanTransitionRule,
} from './rules.verified.ts';

export interface TaskCreationFacts {
	/** The operation is being authorized by the originating room. */
	readonly origin: boolean;
	/** The originating exchange is still open. */
	readonly exchangeOpen: boolean;
}

export interface TaskMutationFacts {
	/** The operation is being authorized by the originating room. */
	readonly origin: boolean;
	/** The source activation belongs to the Task owner. */
	readonly owner: boolean;
	/** The operation is being authorized by the Task's working room. */
	readonly working: boolean;
	/** The operation is a Task-directed instruction, rather than a worker update. */
	readonly steering: boolean;
}

/** Root-only Task creation authority. */
export function taskCreationAllowed(facts: TaskCreationFacts): boolean {
	return taskCanCreateRule(facts.origin, facts.exchangeOpen);
}

/** Owner or working-room worker mutation authority. */
export function taskMutationAllowed(facts: TaskMutationFacts): boolean {
	return taskCanMutateRule(facts.origin, facts.owner, facts.working, facts.steering);
}

/** A Task's accepted event stream cannot move a terminal Task again. */
export function taskTransitionAllowed(
	status: 'open' | 'succeeded' | 'failed',
	replay = false,
): boolean {
	return taskCanTransitionRule(status === 'open', replay);
}
