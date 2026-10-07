import { createRuntime, startRoom } from '@ambionframework/ambion';
import {
	byAgent,
	callTool,
	quiet,
	type Reply,
	type ScriptStep,
	say,
	scripted,
	settled,
} from '@ambionframework/ambion/testing';
import { memoryJournals } from '@ambionframework/journal';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { people, team } from '../src/definitions.ts';
import { openInstrument } from '../src/instrument.ts';
import { labRepositories } from '../src/repositories.ts';
import { instruments, labAppendOnly, labSchema } from '../src/scenarios.ts';
import { bundleCanvas } from './hosting.ts';

/** The Workbench team over an in-memory workspace and lab database. The test disposes them. */
function build() {
	const workspace = openWorkspace({
		name: 'workbench',
		backend: {
			bash: memoryBackend({ git: labRepositories(':memory:') }),
			sql: sqliteBackend(':memory:', {
				schema: labSchema,
				appendOnly: labAppendOnly,
				provenance: true,
			}),
		},
	});
	onTestFinished(() => workspace.dispose());
	const lab = workspace.sql;
	if (lab === undefined) throw new Error('The workspace has no lab database.');
	return team(workspace, openInstrument({ lab, instruments }), bundleCanvas());
}

/** The name and the schema of each tool an executor carries, in order. */
const shapeOf = (tools: readonly { name: string; parameters: unknown }[]) =>
	tools.map(({ name, parameters }) => ({ name, parameters: JSON.stringify(parameters) }));

describe('the Workbench tool set', () => {
	it('puts the specialists on Pi, Claude, and Codex with their models, gives every specialist the same tools, and enables no native tool', async () => {
		const built = build();
		expect(built.specialists.map((seat) => seat.executor.kind)).toEqual(['pi', 'claude', 'codex']);
		const [first, ...rest] = built.specialists;
		const expected = shapeOf(first?.executor.tools ?? []);
		expect(expected.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				'read',
				'write',
				'edit',
				'apply_patch',
				'bash',
				'sql',
				'repos',
				'fork',
				'operate',
			]),
		);
		for (const agent of rest) expect(shapeOf(agent.executor.tools), agent.name).toEqual(expected);
		// Only the assistant opens a breakout room, and only a worker reports.
		const names = (agent: { executor: { tools: readonly { name: string }[] } }) =>
			agent.executor.tools.map((tool) => tool.name);
		expect(names(built.assistant)).toEqual(expect.arrayContaining(['breakout', 'tell', 'archive']));
		expect(names(built.assistant)).not.toContain('report');
		// Every seat of a root room and every worker can pin a file.
		for (const agent of [built.assistant, ...built.specialists, ...built.workers])
			expect(names(agent), agent.name).toEqual(expect.arrayContaining(['show', 'hide']));
		for (const agent of built.specialists)
			expect(names(agent), agent.name).not.toEqual(expect.arrayContaining(['breakout', 'report']));
		expect(built.workers.map((worker) => worker.name)).toEqual(['scout', 'maker']);
		for (const worker of built.workers) {
			expect(names(worker), worker.name).toEqual(expect.arrayContaining(['read', 'sql', 'report']));
			expect(names(worker), worker.name).not.toEqual(
				expect.arrayContaining(['breakout', 'operate']),
			);
		}
		const [firstSpecialist, ...otherSpecialists] = built.specialists;
		for (const agent of otherSpecialists)
			expect(agent.executor.guidance, agent.name).toEqual(firstSpecialist?.executor.guidance);

		const executors = Object.fromEntries(
			built.specialists.map((seat) => [seat.name, seat.executor]),
		);
		expect(executors.datasheets).toMatchObject({ kind: 'pi' });
		expect(executors.design).toMatchObject({ kind: 'claude', model: 'claude-sonnet-5' });
		for (const option of [
			'allowedTools',
			'disallowedTools',
			'permissionMode',
			'canUseTool',
			'cwd',
			'additionalDirectories',
		])
			expect(executors.design, option).not.toHaveProperty(option);
		expect(executors.experiments).toMatchObject({
			kind: 'codex',
			model: 'gpt-5.6-luna',
			modelReasoningEffort: 'medium',
		});
	});
});

describe('the Workbench filesystem', () => {
	it('lets the Claude seat write a file that the Codex seat reads back', async () => {
		const built = build();
		const mira = people[0];
		if (!mira) throw new Error('No person.');
		const marker = 'resistor 330 ohm';
		const script = byAgent({
			assistant: (_step, _seat, request) =>
				request === 1 ? say('Please plan.', 'design') : quiet(),
			design: (_step, _seat, request) => {
				if (request === 1)
					return callTool('write', { path: '/shared/handoff.md', content: marker });
				if (request === 2) return say('Written.', 'experiments');
				return quiet();
			},
			experiments: (step, _seat, request) => {
				if (request === 1) return callTool('read', { path: '/shared/handoff.md' });
				if (request === 2) return say(`Read back: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await startRoom({
			name: 'toolset',
			goal: 'Share a file.',
			agents: built.specialists,
			assistant: built.assistant,
			runtime: createRuntime({ storage: memoryJournals() }),
			execution: scripted(script),
			seats: { design: 'named', experiments: 'named' },
		});
		onTestFinished(() => room.stop());
		await (await room.visit(mira)).send({ text: 'Share a file.' });
		await settled(room);
		const read = await room.read();
		const said = read.messages.filter((message) => message.kind === 'said');
		expect(
			said.some((message) => message.from === 'experiments' && message.text.includes(marker)),
		).toBe(true);
	});
});

describe('the Workbench repositories', () => {
	it('lets the Design seat fork the firmware template and push a branch that the Experiments seat reviews', async () => {
		const built = build();
		const theo = people[1];
		if (!theo) throw new Error('No person.');
		const pin = /\| LED +\| 13 +\|/;
		const script = byAgent({
			assistant: (_step, _seat, request) =>
				request === 1 ? say('Start the firmware.', 'design') : quiet(),
			design: (step, _seat, request) => {
				const steps = [
					callTool('fork', {
						source: 'templates/firmware-sketch',
						name: 'firmware',
						clone: '~/firmware',
					}),
					callTool('bash', {
						command:
							"cd ~/firmware && git switch -c sensing && sed -i 's/^| LED \\( *\\)| TBD /| LED \\1| 13  /' pins.md && git commit -am 'Set the LED pin' && git push origin sensing",
					}),
				];
				if (request <= steps.length) return steps[request - 1] ?? quiet();
				if (request === steps.length + 1)
					return say(`Pushed: ${step.results.at(-1)?.text}`, 'experiments');
				return quiet();
			},
			experiments: (step, _seat, request) => {
				if (request === 1) return callTool('repos', { namespace: 'design' });
				if (request === 2)
					return callTool('bash', {
						command:
							'git clone http://git.ambion.invalid/design/firmware ~/review && cd ~/review && git checkout sensing && cat pins.md',
					});
				if (request === 3) return say(`Review: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await startRoom({
			name: 'firmware',
			goal: 'Start the firmware.',
			agents: built.specialists,
			assistant: built.assistant,
			runtime: createRuntime({ storage: memoryJournals() }),
			execution: scripted(script),
			seats: { design: 'named', experiments: 'named' },
		});
		onTestFinished(() => room.stop());
		await (await room.visit(theo)).send({ text: 'Start the firmware.' });
		await settled(room);
		const said = (await room.read()).messages.filter((message) => message.kind === 'said');
		const review = said.find((message) => message.from === 'experiments');
		expect(review?.text).toMatch(pin);
		const fork = await built.workspace.git?.use({ name: 'design' }, (env) =>
			env.get('design/firmware'),
		);
		expect(fork?.source).toBe('templates/firmware-sketch');
		expect(Object.keys(fork?.branches ?? {}).sort()).toEqual(['main', 'sensing']);
		expect(fork?.branches.sensing).not.toBe(fork?.branches.main);
	}, 20_000);

	it('starts a parameter sweep from the fork in the background, and a later exchange in the room reads its end', async () => {
		const built = build();
		const theo = people[1];
		if (!theo) throw new Error('No person.');
		// The text of the latest spoken message: each seat answers the latest ask.
		const latest = (step: ScriptStep) => {
			const said = step.view.context.messages.filter((message) => message.kind === 'said');
			return said.at(-1);
		};
		// Each list holds the replies of one ask, by the count of results so far.
		const start = (step: ScriptStep): Reply | undefined =>
			[
				callTool('fork', {
					source: 'templates/firmware-sketch',
					name: 'firmware',
					clone: '~/firmware',
				}),
				callTool('bash', {
					command: 'cd ~/firmware && bash sweep/sweep.sh 0.2',
					name: 'sweep',
					wait: 0,
				}),
				say(`Started: ${step.results[1]?.text}`, 'assistant'),
			][step.results.length];
		const check = (step: ScriptStep): Reply | undefined => {
			const handle = step.results[0]?.text.match(/bash-[0-9a-f]{12}/)?.[0];
			return [
				callTool('ps'),
				callTool('wait', { handles: [handle], timeout: 30 }),
				say(`${step.results[0]?.text}\n${step.results[1]?.text}`, 'assistant'),
			][step.results.length];
		};
		const script = byAgent({
			assistant: (step) => {
				const ask = latest(step);
				return ask?.from === theo.name && step.results.length === 0
					? say(ask.text, 'design')
					: quiet();
			},
			design: (step) =>
				(latest(step)?.text.startsWith('Start') ? start(step) : check(step)) ?? quiet(),
		});
		const room = await startRoom({
			name: 'sweep',
			goal: 'Sweep the LED resistor.',
			agents: built.specialists,
			assistant: built.assistant,
			runtime: createRuntime({ storage: memoryJournals() }),
			execution: scripted(script),
			seats: { design: 'named' },
		});
		onTestFinished(() => room.stop());
		const visit = await room.visit(theo);
		await visit.send({ text: 'Start the resistor sweep.' });
		await settled(room);
		await visit.send({ text: 'Check the sweep.' });
		await settled(room);
		const said = (await room.read()).messages.filter(
			(message) => message.kind === 'said' && message.from === 'design',
		);
		const [started, checked] = said.map((message) => (message.kind === 'said' ? message.text : ''));
		const handle = started?.match(/bash-[0-9a-f]{12}/)?.[0] ?? 'none';
		expect(started).toContain(`[Process ${handle} (sweep) is running.`);
		// The second exchange finds the sweep with ps, and waits on its handle.
		expect(checked).toMatch(new RegExp(`\\| ${handle} \\| sweep \\|`));
		expect(checked).toContain('sweep done: 10 rows in sweep/results.csv');
		expect(checked).toContain(`[Process ${handle} (sweep) exited with code 0.`);
		const { exchanges } = await room.read();
		expect(exchanges).toHaveLength(2);
	}, 20_000);
});
