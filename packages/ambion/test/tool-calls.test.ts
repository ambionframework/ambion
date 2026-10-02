/**
 * The core raises the tool events from the steps an executor records. A
 * `tool_call` step starts a call and a `tool_result` step with the same id
 * ends it. A room tool that commits an entry raises no tool event: the
 * `message` event of the entry reports it. A harness that cannot see the id
 * of a call takes it from the steps, and a result drops the id it ends.
 */
import { expect, it } from 'vitest';
import { ToolCalls } from '../src/execution/tool-calls.ts';
import type { Step } from '../src/types.ts';

const calls = () => {
	const raised: string[] = [];
	const recorded: Step[] = [];
	const tools = new ToolCalls('act-1', (type, tool) => raised.push(`${type}:${tool}`));
	const trace = tools.watching({ record: (step) => void recorded.push(step) });
	return { tools, trace, raised, recorded };
};

const call = (id: string, name: string): Step => ({ type: 'tool_call', call: id, name, input: {} });
const result = (id: string): Step => ({ type: 'tool_result', call: id, output: 'ok' });

it.each([
	['say', false],
	['schedule', false],
	['seat', false],
	['unseat', false],
	['dismiss', false],
	['recall', true],
	['lookup', true],
] as const)('raises tool events for a call of %s: %s', (name, raises) => {
	const { trace, raised, recorded } = calls();
	trace.record(call('c1', name));
	trace.record(result('c1'));
	expect(recorded).toHaveLength(2);
	expect(raised).toEqual(raises ? [`tool_call:${name}`, `tool_result:${name}`] : []);
});

it('pairs a result with its call by id, and raises no end for a result with no call', () => {
	const { trace, raised } = calls();
	trace.record(call('c1', 'lookup'));
	trace.record(call('c2', 'fetch'));
	trace.record(result('c2'));
	trace.record(result('c9'));
	trace.record(result('c1'));
	trace.record(result('c1'));
	expect(raised).toEqual([
		'tool_call:lookup',
		'tool_call:fetch',
		'tool_result:fetch',
		'tool_result:lookup',
	]);
});

it('hands out the ids the steps named for a tool, in order, then fresh ids', () => {
	const { tools, trace } = calls();
	trace.record(call('t1', 'say'));
	trace.record(call('t2', 'lookup'));
	trace.record(call('t3', 'say'));
	expect(tools.callId('say')).toBe('t1');
	expect(tools.callId('say')).toBe('t3');
	expect(tools.callId('say')).toBe('act-1:say:0');
	expect(tools.callId('lookup')).toBe('t2');
	expect(tools.callId('lookup')).toBe('act-1:lookup:1');
});

it('drops the id of a call its result ends, so a harness that never takes one holds none', () => {
	const { tools, trace } = calls();
	for (const id of ['t1', 't2', 't3']) {
		trace.record(call(id, 'lookup'));
		trace.record(result(id));
	}
	trace.record(call('t4', 'lookup'));
	expect(tools.callId('lookup')).toBe('t4');
	expect(tools.callId('lookup')).toBe('act-1:lookup:0');
});

it('gives a nested step no id to claim, and raises its tool events', () => {
	const { tools, trace, raised } = calls();
	// A direct bash call and a nested bash step of one batch, in either order.
	trace.record({ type: 'tool_call', call: 'n1', name: 'bash', input: {}, parent: 'c0' });
	trace.record(call('d1', 'bash'));
	trace.record({ type: 'tool_call', call: 'n2', name: 'bash', input: {}, parent: 'c0' });
	expect(tools.callId('bash')).toBe('d1');
	expect(tools.callId('bash')).toBe('act-1:bash:0');
	trace.record({ type: 'tool_result', call: 'n1', output: 'ok', parent: 'c0' });
	trace.record({ type: 'tool_result', call: 'n2', output: 'ok', parent: 'c0' });
	expect(raised).toEqual([
		'tool_call:bash',
		'tool_call:bash',
		'tool_call:bash',
		'tool_result:bash',
		'tool_result:bash',
	]);
});
