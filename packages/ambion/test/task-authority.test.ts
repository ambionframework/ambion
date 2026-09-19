import { describe, expect, it } from 'vitest';
import {
	type TaskCreationFacts,
	type TaskMutationFacts,
	taskCreationAllowed,
	taskMutationAllowed,
	taskTransitionAllowed,
} from '../src/room/task-authority.ts';

const creationFacts = (overrides: Partial<TaskCreationFacts> = {}): TaskCreationFacts => ({
	origin: true,
	exchangeOpen: true,
	...overrides,
});

const mutationFacts = (overrides: Partial<TaskMutationFacts> = {}): TaskMutationFacts => ({
	origin: true,
	owner: true,
	working: false,
	steering: false,
	...overrides,
});

describe('Task authority predicates', () => {
	it('allows root creation only from a live ordinary owner activation', () => {
		expect(taskCreationAllowed(creationFacts())).toBe(true);
		expect(taskCreationAllowed(creationFacts({ origin: false }))).toBe(false);
		expect(taskCreationAllowed(creationFacts({ exchangeOpen: false }))).toBe(false);
	});

	it('allows owner updates at origin and worker updates in the working room', () => {
		expect(taskMutationAllowed(mutationFacts())).toBe(true);
		expect(taskMutationAllowed(mutationFacts({ origin: true, owner: false }))).toBe(false);
		expect(taskMutationAllowed(mutationFacts({ origin: false, owner: false, working: true }))).toBe(
			true,
		);
		expect(
			taskMutationAllowed(mutationFacts({ origin: false, working: true, steering: true })),
		).toBe(false);
	});

	it('keeps terminal status immutable while accepting the same operation retry', () => {
		expect(taskTransitionAllowed('open')).toBe(true);
		expect(taskTransitionAllowed('succeeded')).toBe(false);
		expect(taskTransitionAllowed('failed')).toBe(false);
		expect(taskTransitionAllowed('succeeded', true)).toBe(true);
	});
});
