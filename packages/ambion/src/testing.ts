/**
 * The third entry: the deterministic tools a test needs to run a room
 * without a model. `scripted` is an execution that runs a script, `settled`
 * is the wait, and `fakeClock` moves time by hand. It imports no model
 * library. A test that needs a Pi stream imports `@ambionframework/pi/testing`.
 */
export { type FakeClock, fakeClock } from './testing/clock.ts';
export {
	byAgent,
	type Call,
	callTool,
	isClosing,
	quiet,
	type Result,
	type Script,
	ScriptedFailure,
	type Step,
	scripted,
	scriptedExecutor,
	speak,
	spend,
	type Turn,
} from './testing/scripted.ts';
export { type Settleable, type SettledOptions, settled } from './testing/settled.ts';
