import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, startRoom } from '@ambionframework/ambion';
import {
	byAgent,
	callTool,
	quiet,
	scripted,
	settled,
	speak,
} from '@ambionframework/ambion/testing';
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/workspace/just-bash';
import { openSqlResource } from '@ambionframework/workspace/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { people, team } from '../src/definitions.ts';
import { openInstrument } from '../src/instrument.ts';
import { instruments, labSchema, labWritable } from '../src/scenarios.ts';

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined);
});

async function build() {
	const directory = await mkdtemp(join(tmpdir(), 'ambion-workbench-toolset-'));
	const workspace = openWorkspace({ name: 'workbench', backend: memoryBackend() });
	const lab = openSqlResource({
		name: 'lab',
		location: join(directory, 'lab.db'),
		schema: labSchema,
		writable: labWritable,
	});
	cleanups.push(
		() => workspace.dispose(),
		() => lab.dispose(),
		() => rm(directory, { recursive: true, force: true }),
	);
	return team(workspace, lab, openInstrument({ lab, instruments }));
}

/** The name and the schema of each tool an executor carries, in order. */
const shapeOf = (tools: readonly { name: string; parameters: unknown }[]) =>
	tools.map(({ name, parameters }) => ({ name, parameters: JSON.stringify(parameters) }));

describe('the Workbench tool set', () => {
	it('puts the specialists on Pi, Claude, and Codex', async () => {
		const built = await build();
		expect(built.specialists.map((seat) => seat.executor.kind)).toEqual(['pi', 'claude', 'codex']);
	});

	it('gives every agent the same tools, with the same schemas and guidance', async () => {
		const built = await build();
		const [first, ...rest] = built.agents;
		const expected = shapeOf(first?.executor.tools ?? []);
		expect(expected.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				'read',
				'write',
				'edit',
				'bash',
				'sql',
				'query',
				'record',
				'operate',
			]),
		);
		for (const agent of rest) expect(shapeOf(agent.executor.tools), agent.name).toEqual(expected);
		const [firstSpecialist, ...otherSpecialists] = built.specialists;
		for (const agent of otherSpecialists) {
			expect(agent.executor.guidance, agent.name).toEqual(firstSpecialist?.executor.guidance);
		}
	});

	it('enables no native tool on the Claude and Codex seats', async () => {
		const built = await build();
		const executors = Object.fromEntries(
			built.specialists.map((seat) => [seat.name, seat.executor]),
		);
		const claude = executors.design;
		expect(claude).toMatchObject({ kind: 'claude' });
		expect(claude).not.toHaveProperty('allowedTools');
		expect(claude).not.toHaveProperty('disallowedTools');
		const codex = executors.experiments;
		expect(codex).toMatchObject({ kind: 'codex', nativeTools: 'none' });
		for (const option of [
			'sandboxMode',
			'approvalPolicy',
			'networkAccessEnabled',
			'workingDirectory',
			'additionalDirectories',
		]) {
			expect(codex, option).not.toHaveProperty(option);
		}
	});
});

describe('the Workbench filesystem', () => {
	it('lets the Claude seat write a file that the Codex seat reads back', async () => {
		const built = await build();
		const mira = people[0];
		if (!mira) throw new Error('No person.');
		const marker = 'resistor 330 ohm';
		const script = byAgent({
			assistant: (_step, _seat, call) => (call === 1 ? speak('Please plan.', 'design') : quiet()),
			design: (_step, _seat, call) => {
				if (call === 1) return callTool('write', { path: '/shared/handoff.md', content: marker });
				if (call === 2) return speak('Written.', 'experiments');
				return quiet();
			},
			experiments: (step, _seat, call) => {
				if (call === 1) return callTool('read', { path: '/shared/handoff.md' });
				if (call === 2) return speak(`Read back: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await startRoom({
			name: 'toolset',
			goal: 'Share a file.',
			agents: built.specialists,
			assistant: built.assistant,
			runtime: createRuntime(),
			execution: scripted(script),
			seats: { design: 'named', experiments: 'named' },
		});
		cleanups.push(() => room.stop());
		await (await room.visit(mira)).send({ text: 'Share a file.' });
		await settled(room);
		const read = await room.read();
		const said = read.messages.filter((message) => message.kind === 'said');
		expect(
			said.some((message) => message.from === 'experiments' && message.text.includes(marker)),
		).toBe(true);
	});
});
