import { expect, it } from 'vitest';
import { composeExecutions, describeExecutor, type Execution } from '../src/hosting.ts';
import { defineAgent } from '../src/index.ts';

/** An execution whose connector remembers the seats it connected. */
function recording(connected: string[]): Execution {
	return {
		connector: () => ({
			connect: (_room, request) => {
				connected.push(request.seat);
				return { wake: async () => {}, steer: async () => {}, cut: async () => {} };
			},
		}),
	};
}

const seatOf = (name: string, kind: string) =>
	defineAgent({ name, identity: name, executor: describeExecutor({ kind, instructions: '' }) });

const host = {
	clock: { now: () => 0, alarm: () => () => {} },
	storage: {},
	limits: {},
} as never;

const connect = (execution: Execution, name: string, kind: string) =>
	execution.connector(host).connect({} as never, {
		room: 'lab',
		seat: name,
		definition: seatOf(name, kind),
		emit: () => {},
	});

it('routes each seat to the execution named for its executor kind', () => {
	const pi: string[] = [];
	const claude: string[] = [];
	const execution = composeExecutions({ pi: recording(pi), claude: recording(claude) });
	connect(execution, 'pilot', 'pi');
	connect(execution, 'sonnet', 'claude');
	expect(pi).toEqual(['pilot']);
	expect(claude).toEqual(['sonnet']);
});

it('refuses a seat whose executor kind has no execution, and names the kinds it knows', () => {
	const execution = composeExecutions({ pi: recording([]) });
	expect(() => connect(execution, 'sonnet', 'claude')).toThrow(
		"No execution serves seat 'sonnet' of kind 'claude'. Known kinds: pi.",
	);
});
