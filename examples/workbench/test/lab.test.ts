import { join } from 'node:path';
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { memoryBackend } from '@ambionframework/just-bash';
import { BACKGROUND_CONTEXT, openWorkspace, type SqlEnv } from '@ambionframework/workspace';
import type { WorkspaceResource } from '@ambionframework/workspace/resource';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readApprovals } from '../src/approvals.ts';
import { openInstrument } from '../src/instrument.ts';
import { instruments, labAppendOnly, labSchema } from '../src/scenarios.ts';
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

/** A workspace over the lab database, with the options of the host. The test disposes it. */
function openLab(location = ':memory:') {
	const workspace = openWorkspace({
		name: 'lab',
		backend: {
			bash: memoryBackend(),
			sql: sqliteBackend(location, {
				schema: labSchema,
				appendOnly: labAppendOnly,
				provenance: true,
			}),
		},
	});
	onTestFinished(() => workspace.dispose());
	const lab = workspace.sql;
	if (lab === undefined) throw new Error('The workspace has no lab database.');
	return { workspace, lab };
}

/** Call a tool so that a synchronous throw becomes a rejection. */
function caller(tools: readonly AmbionTool[]) {
	return (name: string, params: object, ctx: ToolContext) => {
		const found = tools.find((candidate) => candidate.name === name);
		if (!found) throw new Error(`No tool ${name}`);
		return Promise.resolve().then(() => found.invoke(params, ctx));
	};
}

/** The rows of `sql` on the lab database, read as host code does. */
const query = (lab: WorkspaceResource<SqlEnv>, sql: string) =>
	lab.use({ name: 'test' }, async (env) => {
		const outcome = await env.run(sql, { maxRows: 1000 }, BACKGROUND_CONTEXT);
		if (!outcome.ok) throw new Error(outcome.message);
		return outcome.rows;
	});
const operations = (lab: WorkspaceResource<SqlEnv>) =>
	query(lab, 'SELECT * FROM operations ORDER BY id');

/** A lab with its instrument, and the calls of the instrument tools. */
function bench() {
	const { lab } = openLab();
	const bundle = openInstrument({ lab, instruments }).tools();
	const call = caller(bundle.tools);
	const operate = (instrument: string, setpoint: number, ctx = contextOf('design', 'act-1')) =>
		call('operate', { instrument, setpoint }, ctx);
	const answer = (id: number, decision: string, ctx = contextOf('design', 'act-2')) =>
		call('approve_operation', { id, decision }, ctx);
	return { lab, bundle, operate, answer };
}

/** The text of a tool result. */
const textOf = (result: unknown): string =>
	typeof result === 'string'
		? result
		: ((result as { content?: { text?: string }[] }).content ?? [])
				.map((part) => part.text ?? '')
				.join('');

describe('the lab database', () => {
	it('lets one agent record a run with sql and another agent read it back, and refuses an UPDATE and a DELETE of a record', async () => {
		const { workspace } = openLab(join(await freshDirectory(), 'lab.db'));
		const call = caller(workspace.tools().tools);
		const at = (agent: string, activation: string) => ({
			...contextOf(agent, activation, 'theo'),
			room: 'sensing',
		});
		await call(
			'sql',
			{ sql: "INSERT INTO runs (project, label) VALUES ('sensing', 'range at 50 cm')" },
			at('experiments', 'act-1'),
		);
		const shown = await call(
			'sql',
			{ sql: 'SELECT project, label, agent, room, activation FROM runs' },
			at('design', 'act-2'),
		);
		expect(textOf(shown)).toContain('| sensing | range at 50 cm | experiments | sensing | act-1 |');
		await expect(
			call('sql', { sql: "UPDATE projects SET goal = 'y'" }, at('design', 'a')),
		).rejects.toThrow(/append-only/);
		await expect(
			call('sql', { sql: "DELETE FROM runs WHERE label = 'range at 50 cm'" }, at('design', 'a')),
		).rejects.toThrow(/append-only/);
		expect(workspace.tools().guidance).toContain(
			'The tables projects, test_plans, runs, results, operations accept INSERT alone',
		);
	});

	it('opens the lab database beside the journal database and seeds the projects', async () => {
		const directory = await freshDirectory();
		// The host runs on the environment of the process. It sends no message, so no model runs.
		await (await openHost({ directory, stream: undefined, executions: undefined })).close();
		const { lab } = openLab(join(directory, 'lab.db'));
		const rows = await query(lab, 'SELECT name FROM projects ORDER BY name');
		expect(rows.map((row) => row.name)).toEqual(['bringup', 'firmware', 'power', 'sensing']);
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
		expect(labAppendOnly).toContain('operations');
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
		const { lab, operate, answer } = bench();
		await expect(answer(-1, 'allow')).rejects.toThrow(/non-negative integer/);
		await expect(answer(1.5, 'allow')).rejects.toThrow(/non-negative integer/);
		await expect(answer(7, 'allow')).rejects.toThrow(/No requested operation 7/);
		await expect(operate('laser', 1)).rejects.toThrow(/Unknown instrument/);
		const { exchange: _exchange, ...bare } = contextOf('design', 'act-1');
		await expect(operate('led-current', 30, bare)).rejects.toThrow(/open exchange/);
		// Within the limit, an operation runs with no exchange, and its exchange columns stay NULL.
		expect(await operate('led-current', 5, bare)).toContain('reading 5');
		expect(await operations(lab)).toEqual([
			expect.objectContaining({ agent: 'design', exchange_owner: null, exchange_from: null }),
		]);
	});

	it('rejects an operation when the lab database refuses the statement', async () => {
		const workspace = openWorkspace({
			name: 'empty',
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		onTestFinished(() => workspace.dispose());
		const lab = workspace.sql;
		if (lab === undefined) throw new Error('The workspace has no lab database.');
		const [operate] = openInstrument({ lab, instruments }).tools().tools;
		await expect(
			Promise.resolve().then(() =>
				operate?.invoke({ instrument: 'led-current', setpoint: 1 }, contextOf('design', 'a')),
			),
		).rejects.toThrow(/no such table: operations/);
		await expect(readApprovals(lab, 'bringup')).rejects.toThrow(/no such table: operations/);
	});
});
