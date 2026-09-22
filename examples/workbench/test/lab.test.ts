import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { openSqlResource } from '@ambionframework/workspace/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { labSchema, labWritable } from '../src/scenarios.ts';
import { openWorkbench } from '../src/workbench.ts';

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function contextOf(agent: string, activation: string): ToolContext {
	return {
		agent: { name: agent, identity: agent },
		callId: `${agent}-call`,
		room: 'sensing',
		activation,
		exchange: { owner: 'theo', from: 4 },
	};
}

function tool(tools: readonly AmbionTool[], name: string): AmbionTool {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`No tool ${name}`);
	return found;
}

describe('the lab SQL resource', () => {
	it('lets one agent record a run and another agent query it back', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-workbench-lab-'));
		directories.push(directory);
		const lab = openSqlResource({
			name: 'lab',
			location: join(directory, 'lab.db'),
			schema: labSchema,
			writable: labWritable,
		});
		const { tools } = lab.tools();
		await tool(tools, 'record').invoke(
			{ table: 'runs', values: { project: 'sensing', label: 'range at 50 cm' } },
			contextOf('experiments', 'act-1'),
		);
		const shown = await tool(tools, 'query').invoke(
			{ sql: 'SELECT project, label, agent, room, activation FROM runs' },
			contextOf('design', 'act-2'),
		);
		expect(shown).toContain('| sensing | range at 50 cm | experiments | sensing | act-1 |');
		await expect(
			Promise.resolve().then(() =>
				tool(tools, 'record').invoke(
					{ table: 'projects', values: { name: 'x', goal: 'y' } },
					contextOf('design', 'act-2'),
				),
			),
		).rejects.toThrow(/does not accept records/);
		await lab.dispose();
	});

	it('opens the lab database beside the journal database and seeds the projects', async () => {
		const directory = join(await mkdtemp(join(tmpdir(), 'ambion-workbench-lab-')), 'run');
		directories.push(join(directory, '..'));
		const workbench = await openWorkbench({ directory });
		await workbench.close();
		const lab = openSqlResource({
			name: 'lab',
			location: join(directory, 'lab.db'),
			schema: labSchema,
			writable: labWritable,
		});
		const rows = await lab.use({ name: 'test' }, (env) =>
			env.query('SELECT name FROM projects ORDER BY name'),
		);
		expect(rows.map((row) => row.name)).toEqual(['bringup', 'power', 'sensing']);
		await lab.dispose();
	});
});
