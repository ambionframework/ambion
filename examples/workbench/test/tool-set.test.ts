import { createRuntime, startRoom } from '@ambionframework/ambion';
import {
	byAgent,
	callTool,
	quiet,
	type Step,
	scripted,
	settled,
	speak,
	type Turn,
} from '@ambionframework/ambion/testing';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { openSqlResource } from '@ambionframework/workspace/sql';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { people, team } from '../src/definitions.ts';
import { openInstrument } from '../src/instrument.ts';
import { labRepositories } from '../src/repositories.ts';
import { instruments, labSchema, labWritable } from '../src/scenarios.ts';

/** The Workbench team over an in-memory workspace and lab. The test disposes them. */
function build() {
	const workspace = openWorkspace({
		name: 'workbench',
		backend: {
			bash: memoryBackend(),
			sql: sqliteBackend(':memory:'),
			git: labRepositories(':memory:'),
		},
	});
	const lab = openSqlResource({
		name: 'lab',
		location: ':memory:',
		schema: labSchema,
		writable: labWritable,
	});
	onTestFinished(async () => {
		await workspace.dispose();
		await lab.dispose();
	});
	return team(workspace, lab, openInstrument({ lab, instruments }));
}

/** The name and the schema of each tool an executor carries, in order. */
const shapeOf = (tools: readonly { name: string; parameters: unknown }[]) =>
	tools.map(({ name, parameters }) => ({ name, parameters: JSON.stringify(parameters) }));

describe('the Workbench tool set', () => {
	it('puts the specialists on Pi, Claude, and Codex with their models, gives every agent the same tools, and enables no native tool', async () => {
		const built = build();
		expect(built.specialists.map((seat) => seat.executor.kind)).toEqual(['pi', 'claude', 'codex']);
		const [first, ...rest] = built.agents;
		const expected = shapeOf(first?.executor.tools ?? []);
		expect(expected.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				'read',
				'write',
				'edit',
				'bash',
				'sql',
				'repos',
				'fork',
				'query',
				'record',
				'operate',
			]),
		);
		for (const agent of rest) expect(shapeOf(agent.executor.tools), agent.name).toEqual(expected);
		const [firstSpecialist, ...otherSpecialists] = built.specialists;
		for (const agent of otherSpecialists)
			expect(agent.executor.guidance, agent.name).toEqual(firstSpecialist?.executor.guidance);

		const executors = Object.fromEntries(
			built.specialists.map((seat) => [seat.name, seat.executor]),
		);
		expect(executors.datasheets).toMatchObject({ kind: 'pi' });
		expect(executors.design).toMatchObject({ kind: 'claude', model: 'claude-sonnet-5' });
		expect(executors.design).not.toHaveProperty('allowedTools');
		expect(executors.design).not.toHaveProperty('disallowedTools');
		expect(executors.experiments).toMatchObject({
			kind: 'codex',
			model: 'gpt-5.6-luna',
			modelReasoningEffort: 'medium',
			nativeTools: 'none',
		});
		for (const option of [
			'sandboxMode',
			'approvalPolicy',
			'networkAccessEnabled',
			'workingDirectory',
			'additionalDirectories',
		])
			expect(executors.experiments, option).not.toHaveProperty(option);
	});
});

describe('the Workbench filesystem', () => {
	it('lets the Claude seat write a file that the Codex seat reads back', async () => {
		const built = build();
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
			assistant: (_step, _seat, call) =>
				call === 1 ? speak('Start the firmware.', 'design') : quiet(),
			design: (step, _seat, call) => {
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
				if (call <= steps.length) return steps[call - 1] ?? quiet();
				if (call === steps.length + 1)
					return speak(`Pushed: ${step.results.at(-1)?.text}`, 'experiments');
				return quiet();
			},
			experiments: (step, _seat, call) => {
				if (call === 1) return callTool('repos', { namespace: 'design' });
				if (call === 2)
					return callTool('bash', {
						command:
							'git clone http://git.ambion.invalid/design/firmware ~/review && cd ~/review && git checkout sensing && cat pins.md',
					});
				if (call === 3) return speak(`Review: ${step.results.at(-1)?.text}`, 'assistant');
				return quiet();
			},
		});
		const room = await startRoom({
			name: 'firmware',
			goal: 'Start the firmware.',
			agents: built.specialists,
			assistant: built.assistant,
			runtime: createRuntime(),
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
		const latest = (step: Step) => {
			const said = step.view.context.messages.filter((message) => message.kind === 'said');
			return said.at(-1);
		};
		// Each list holds the turns of one ask, by the count of results so far.
		const start = (step: Step): Turn | undefined =>
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
				speak(`Started: ${step.results[1]?.text}`, 'assistant'),
			][step.results.length];
		const check = (step: Step): Turn | undefined => {
			const handle = step.results[0]?.text.match(/bash-[0-9a-f]{12}/)?.[0];
			return [
				callTool('ps'),
				callTool('wait', { handle, timeout: 30 }),
				speak(`${step.results[0]?.text}\n${step.results[1]?.text}`, 'assistant'),
			][step.results.length];
		};
		const script = byAgent({
			assistant: (step) => {
				const ask = latest(step);
				return ask?.from === theo.name && step.results.length === 0
					? speak(ask.text, 'design')
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
			runtime: createRuntime(),
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
