import { join } from 'node:path';
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { openSqlResource, type SqlResource } from '@ambionframework/workspace/sql';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openInstrument } from '../src/instrument.ts';
import { instruments, labSchema, labWritable } from '../src/scenarios.ts';
import { freshDirectory, openHost } from './hosting.ts';

function contextOf(agent: string, activation: string, owner = 'mira'): ToolContext {
	return {
		agent: { name: agent, identity: agent },
		callId: `${agent}-call`,
		room: 'bringup',
		activation,
		exchange: { owner, from: 2 },
	};
}

/** Open the lab database. The test disposes it when it finishes. */
function openLab(location = ':memory:'): SqlResource {
	const lab = openSqlResource({ name: 'lab', location, schema: labSchema, writable: labWritable });
	onTestFinished(() => lab.dispose());
	return lab;
}

/** Call a tool so that a synchronous throw becomes a rejection. */
function caller(tools: readonly AmbionTool[]) {
	return (name: string, params: object, ctx: ToolContext) => {
		const found = tools.find((candidate) => candidate.name === name);
		if (!found) throw new Error(`No tool ${name}`);
		return Promise.resolve().then(() => found.invoke(params, ctx));
	};
}

const query = (lab: SqlResource, sql: string) => lab.use({ name: 'test' }, (env) => env.query(sql));
const operations = (lab: SqlResource) => query(lab, 'SELECT * FROM operations ORDER BY id');

/** A lab with its instrument, and the calls of the instrument tools. */
function bench() {
	const lab = openLab();
	const bundle = openInstrument({ lab, instruments }).tools();
	const call = caller(bundle.tools);
	const operate = (instrument: string, setpoint: number, ctx = contextOf('design', 'act-1')) =>
		call('operate', { instrument, setpoint }, ctx);
	const answer = (id: number, decision: string, ctx = contextOf('design', 'act-2')) =>
		call('approve_operation', { id, decision }, ctx);
	return { lab, bundle, operate, answer };
}

describe('the lab SQL resource', () => {
	it('lets one agent record a run and another agent query it back', async () => {
		const lab = openLab(join(await freshDirectory(), 'lab.db'));
		const call = caller(lab.tools().tools);
		const at = (agent: string, activation: string) => ({
			...contextOf(agent, activation, 'theo'),
			room: 'sensing',
		});
		await call(
			'record',
			{ table: 'runs', values: { project: 'sensing', label: 'range at 50 cm' } },
			at('experiments', 'act-1'),
		);
		const shown = await call(
			'query',
			{ sql: 'SELECT project, label, agent, room, activation FROM runs' },
			at('design', 'act-2'),
		);
		expect(shown).toContain('| sensing | range at 50 cm | experiments | sensing | act-1 |');
		await expect(
			call('record', { table: 'projects', values: { name: 'x', goal: 'y' } }, at('design', 'a')),
		).rejects.toThrow(/does not accept records/);
	});

	it('opens the lab database beside the journal database and seeds the projects', async () => {
		const directory = await freshDirectory();
		// The host runs on the environment of the process. It sends no message, so no model runs.
		await (await openHost({ directory, stream: undefined, executions: undefined })).close();
		const rows = await query(
			openLab(join(directory, 'lab.db')),
			'SELECT name FROM projects ORDER BY name',
		);
		expect(rows.map((row) => row.name)).toEqual(['bringup', 'power', 'sensing']);
	});
});

describe('the instrument resource', () => {
	it('exposes operate and approve_operation with guidance', () => {
		const { bundle } = bench();
		expect(bundle.tools.map((candidate) => candidate.name)).toEqual([
			'operate',
			'approve_operation',
		]);
		expect(bundle.guidance).toContain('approve_operation');
		expect(labWritable).toContain('operations');
	});

	it('performs an operation at or below the limit and records provenance', async () => {
		const { lab, operate } = bench();
		expect(await operate('led-current', 10)).toContain('reading 10');
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

	it('records a request over the limit, and an approval another activation relays with the reading', async () => {
		const { lab, operate, answer } = bench();
		const shown = await operate('led-current', 30);
		for (const part of ['limit 20', 'exceeds it by 10', 'mira', 'operation 1', 'approve_operation'])
			expect(shown).toContain(part);
		expect(await operations(lab)).toEqual([
			expect.objectContaining({ outcome: 'requested', setpoint: 30, reading: null }),
		]);
		// The person answers in the room. The agent relays the decision.
		expect(await answer(1, 'allow', contextOf('assistant', 'act-2'))).toContain('reading 30');
		expect((await operations(lab))[1]).toMatchObject({
			outcome: 'approved',
			request_id: 1,
			reading: 30,
			instrument: 'led-current',
			agent: 'assistant',
			activation: 'act-2',
		});
		const status = await query(
			lab,
			'SELECT outcome FROM operations WHERE id = 1 OR request_id = 1 ORDER BY id DESC LIMIT 1',
		);
		expect(status).toEqual([{ outcome: 'approved' }]);
	});

	it('inserts again when an activation repeats operate, and records a denial without a reading', async () => {
		const { lab, operate, answer } = bench();
		await operate('bench-supply', 9);
		await operate('bench-supply', 9);
		expect(await answer(1, 'deny')).toContain('denied');
		const rows = await operations(lab);
		expect(rows.map((row) => row.outcome)).toEqual(['requested', 'requested', 'denied']);
		expect(rows[2]).toMatchObject({ request_id: 1, reading: null });
	});

	it('rejects a bad id, an unknown request, an unknown instrument, and a request with no open exchange', async () => {
		const { operate, answer } = bench();
		await expect(answer(-1, 'allow')).rejects.toThrow(/non-negative integer/);
		await expect(answer(1.5, 'allow')).rejects.toThrow(/non-negative integer/);
		await expect(answer(7, 'allow')).rejects.toThrow(/No requested operation 7/);
		await expect(operate('laser', 1)).rejects.toThrow(/Unknown instrument/);
		const { exchange: _exchange, ...bare } = contextOf('design', 'act-1');
		await expect(operate('led-current', 30, bare)).rejects.toThrow(/open exchange/);
	});
});
