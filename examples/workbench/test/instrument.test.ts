import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { openSqlResource, type SqlResource } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { type Instrument, openInstrument } from '../src/instrument.ts';
import { instruments, labSchema, labWritable } from '../src/scenarios.ts';

const labs: SqlResource[] = [];

afterEach(async () => {
	await Promise.all(labs.splice(0).map((lab) => lab.dispose()));
});

function contextOf(agent: string, activation: string, owner = 'mira'): ToolContext {
	return {
		agent: { name: agent, identity: agent },
		callId: `${agent}-call`,
		room: 'bringup',
		activation,
		exchange: { owner, from: 2 },
	};
}

function setup(): { lab: SqlResource; instrument: Instrument } {
	const lab = openSqlResource({
		name: 'lab',
		location: ':memory:',
		schema: labSchema,
		writable: labWritable,
	});
	labs.push(lab);
	return { lab, instrument: openInstrument({ lab, instruments }) };
}

function tool(instrument: Instrument, name: string): AmbionTool {
	const found = instrument.tools().tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`No tool ${name}`);
	return found;
}

const operations = (lab: SqlResource) =>
	lab.use({ name: 'test' }, (env) => env.query('SELECT * FROM operations ORDER BY id'));

/** Call a tool so that a synchronous throw becomes a rejection. */
const call = (instrument: Instrument, name: string, params: object, ctx: ToolContext) =>
	Promise.resolve().then(() => tool(instrument, name).invoke(params, ctx));

describe('the instrument resource', () => {
	it('exposes operate and approve_operation with guidance', () => {
		const { instrument } = setup();
		const bundle = instrument.tools();
		expect(bundle.tools.map((candidate) => candidate.name)).toEqual([
			'operate',
			'approve_operation',
		]);
		expect(bundle.guidance).toContain('approve_operation');
		expect(labWritable).toContain('operations');
	});

	it('performs an operation at or below the limit and records provenance', async () => {
		const { lab, instrument } = setup();
		const shown = await call(
			instrument,
			'operate',
			{ instrument: 'led-current', setpoint: 10 },
			contextOf('design', 'act-1'),
		);
		expect(shown).toContain('reading 10');
		const [row] = await operations(lab);
		expect(row).toMatchObject({
			instrument: 'led-current',
			setpoint: 10,
			outcome: 'done',
			reading: 10,
			agent: 'design',
			room: 'bringup',
			activation: 'act-1',
			exchange_owner: 'mira',
			exchange_from: '2',
		});
		expect(row?.at).toEqual(expect.any(String));
	});

	it('refuses an operation over the limit and records a request', async () => {
		const { lab, instrument } = setup();
		const shown = await call(
			instrument,
			'operate',
			{ instrument: 'led-current', setpoint: 30 },
			contextOf('design', 'act-1'),
		);
		expect(shown).toContain('limit 20');
		expect(shown).toContain('exceeds it by 10');
		expect(shown).toContain('mira');
		expect(shown).toContain('operation 1');
		const rows = await operations(lab);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ outcome: 'requested', setpoint: 30, reading: null });
	});

	it('records an approval with the reading', async () => {
		const { lab, instrument } = setup();
		await call(
			instrument,
			'operate',
			{ instrument: 'led-current', setpoint: 30 },
			contextOf('design', 'act-1'),
		);
		const shown = await call(
			instrument,
			'approve_operation',
			{ id: 1, decision: 'allow' },
			contextOf('design', 'act-2'),
		);
		expect(shown).toContain('reading 30');
		const rows = await operations(lab);
		expect(rows[1]).toMatchObject({
			outcome: 'approved',
			request_id: 1,
			reading: 30,
			instrument: 'led-current',
			activation: 'act-2',
		});
	});

	it('records a denial without a reading', async () => {
		const { lab, instrument } = setup();
		await call(
			instrument,
			'operate',
			{ instrument: 'bench-supply', setpoint: 9 },
			contextOf('design', 'act-1'),
		);
		const shown = await call(
			instrument,
			'approve_operation',
			{ id: 1, decision: 'deny' },
			contextOf('design', 'act-2'),
		);
		expect(shown).toContain('denied');
		const rows = await operations(lab);
		expect(rows[1]).toMatchObject({ outcome: 'denied', request_id: 1, reading: null });
	});

	it('inserts again when an activation repeats operate', async () => {
		const { lab, instrument } = setup();
		const again = () =>
			call(
				instrument,
				'operate',
				{ instrument: 'bench-supply', setpoint: 9 },
				contextOf('design', 'act-1'),
			);
		await again();
		await again();
		expect((await operations(lab)).map((row) => row.outcome)).toEqual(['requested', 'requested']);
	});

	it('rejects a bad id, an unknown request, and an unknown instrument', async () => {
		const { instrument } = setup();
		const approve = (id: number) =>
			call(instrument, 'approve_operation', { id, decision: 'allow' }, contextOf('design', 'a'));
		await expect(approve(-1)).rejects.toThrow(/non-negative integer/);
		await expect(approve(1.5)).rejects.toThrow(/non-negative integer/);
		await expect(approve(7)).rejects.toThrow(/No requested operation 7/);
		await expect(
			call(instrument, 'operate', { instrument: 'laser', setpoint: 1 }, contextOf('design', 'a')),
		).rejects.toThrow(/Unknown instrument/);
	});

	it('refuses an over-limit operation that has no open exchange', async () => {
		const { instrument } = setup();
		const { exchange: _exchange, ...bare } = contextOf('design', 'act-1');
		await expect(
			call(instrument, 'operate', { instrument: 'led-current', setpoint: 30 }, bare),
		).rejects.toThrow(/open exchange/);
	});

	it('runs the approval pattern across two activations', async () => {
		const { lab, instrument } = setup();
		const asked = await call(
			instrument,
			'operate',
			{ instrument: 'bench-supply', setpoint: 6.5 },
			contextOf('design', 'act-1'),
		);
		expect(asked).toContain('approve_operation');
		// The person answers in the room. The agent relays the decision.
		await call(
			instrument,
			'approve_operation',
			{ id: 1, decision: 'allow' },
			contextOf('assistant', 'act-2'),
		);
		const status = await lab.use({ name: 'test' }, (env) =>
			env.query(
				'SELECT outcome FROM operations WHERE id = 1 OR request_id = 1 ORDER BY id DESC LIMIT 1',
			),
		);
		expect(status).toEqual([{ outcome: 'approved' }]);
	});
});
