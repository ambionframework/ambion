/**
 * The third entry: the deterministic tools a test needs to run a room
 * without a model. `scripted` is the stream, `settled` is the wait, and
 * `fakeClock` moves time by hand.
 */
export { type FakeClock, fakeClock } from './testing/clock.ts';
export {
	byAgent,
	callTool,
	isClosing,
	quiet,
	type Script,
	scripted,
	speak,
} from './testing/scripted.ts';
export { type SettledOptions, settled } from './testing/settled.ts';
