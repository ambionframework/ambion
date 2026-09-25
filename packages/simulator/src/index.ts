/**
 * Evals for Ambion rooms. `simulate` drives a room that the test started:
 * an actor plays a person, one exchange at a time, and the run it returns
 * holds what the room did. Checks in code read the run, and a judge grades
 * the criteria that code cannot decide. See `docs/simulator.md`.
 */

export { LIST_ENDED, scriptedActor } from './actor.ts';
export { ACTOR, type AgentActorOptions, agentActor, DEFAULT_MOVE_MS } from './agent-actor.ts';
export {
	type AgentJudgeOptions,
	agentJudge,
	DEFAULT_GRADE_MS,
	type Finding,
	JUDGE,
	type Judge,
	type Verdict,
} from './agent-judge.ts';
export { DEFAULT_EXCHANGE_MS, simulate } from './simulate.ts';
export type {
	Actor,
	Ended,
	Move,
	MoveCall,
	Run,
	RunExchange,
	Seen,
	SeenExchange,
	SimulateOptions,
} from './types.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/simulator';
