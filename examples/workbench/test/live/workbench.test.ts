import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { type Family, hasKey, keyVariable, seatFamilies } from '../../src/families.ts';
import { openWorkbench, type Workbench } from '../../src/workbench.ts';

/**
 * A scenario runs when every family it uses has a key: the assistant runs on
 * Pi, and each named specialist runs on the family that `seatFamilies` gives it.
 */
function missingKeys(scenario: Scenario): string[] {
	const families = new Set<Family>(['pi']);
	for (const name of scenario.specialists) families.add(seatFamilies[name] ?? 'pi');
	return [...families].filter((family) => !hasKey(family)).map((family) => keyVariable(family));
}

interface Scenario {
	name: string;
	person: string;
	request: string;
	specialists: string[];
	summaryCheck: (summary: string) => void;
}

const scenarios: readonly Scenario[] = [
	{
		name: 'bringup',
		person: 'mira',
		request:
			'Pick a series resistor for a red LED at 10 mA on a 5 V pin. Confirm the current stays within the LED and board limits, and cite the datasheet paths.',
		specialists: ['datasheets', 'design'],
		summaryCheck: (summary) => {
			expect(summary).toMatch(/ohm|Ω|resistor/i);
			expect(summary).toMatch(/library/i);
		},
	},
	{
		name: 'sensing',
		person: 'theo',
		request:
			'Plan a repeatable test that measures HC-SR04 distance accuracy from 5 cm to 100 cm. List the steps and the pass criterion.',
		specialists: ['design', 'experiments'],
		summaryCheck: (summary) => expect(summary).toMatch(/step|test|measure|accuracy/i),
	},
];

const spoken = (message: Message) =>
	message.kind === 'said' || message.kind === 'summary' ? message : undefined;

async function untilSummary(
	workbench: Workbench,
	room: string,
	count = 1,
): Promise<readonly Message[]> {
	const deadline = Date.now() + 150_000;
	while (Date.now() < deadline) {
		const { messages } = await workbench.read(room, 0);
		if (messages.filter((message) => message.kind === 'summary').length >= count) return messages;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`The Workbench did not publish a summary for '${room}'.`);
}

/** One test per scenario. Each skips on its own when a family it uses has no key. */
for (const scenario of scenarios) {
	describe.skipIf(missingKeys(scenario).length > 0)(`Workbench ${scenario.name}`, () => {
		it('returns a cited summary from a specialist on its family', async () => {
			const directory = await mkdtemp(join(tmpdir(), `ambion-workbench-${scenario.name}-live-`));
			const workbench = await openWorkbench({ directory: join(directory, 'run') });
			try {
				await workbench.join(scenario.name, scenario.person);
				await workbench.send(
					scenario.name,
					scenario.person,
					`workbench-live-${scenario.name}`,
					scenario.request,
				);
				const messages = await untilSummary(workbench, scenario.name);
				const summary = messages.map(spoken).find((message) => message?.kind === 'summary');
				expect(summary).toMatchObject({ from: 'assistant', to: scenario.person });
				expect(
					messages.some(
						(message) => message.kind === 'said' && scenario.specialists.includes(message.from),
					),
				).toBe(true);
				scenario.summaryCheck(summary?.text ?? '');
				// A scripted run carries no cost, so only a real provider proves it.
				const { exchanges } = await workbench.read(scenario.name, 0);
				const cost = exchanges.flatMap((exchange) =>
					exchange.status === 'closed' && exchange.usage?.cost !== undefined
						? [exchange.usage.cost]
						: [],
				);
				expect(cost.length).toBeGreaterThan(0);
				expect(Math.max(...cost)).toBeGreaterThan(0);
			} finally {
				await workbench.close();
				await rm(directory, { recursive: true, force: true });
			}
		}, 180_000);
	});
}

/** The spec and the end of each process named `name`, from the files of every home. */
async function processesNamed(workspace: string, name: string) {
	const found: { handle: string; exit?: string }[] = [];
	const homes = join(workspace, 'home');
	for (const agent of await readdir(homes)) {
		const root = join(homes, agent, '.processes');
		const handles = await readdir(root).catch(() => []);
		for (const handle of handles) {
			const spec = JSON.parse(await readFile(join(root, handle, 'spec'), 'utf8')) as {
				name?: string;
			};
			if (spec.name !== name) continue;
			const exit = await readFile(join(root, handle, 'exit'), 'utf8').catch(() => undefined);
			found.push({ handle, ...(exit === undefined ? {} : { exit }) });
		}
	}
	return found;
}

/**
 * A parameter sweep from the git template runs in the background. One
 * exchange starts it, and a later exchange in the same room asks for its
 * state. The assistant runs on Pi, and the design seat on Claude.
 */
describe.skipIf(!hasKey('pi') || !hasKey('claude'))('Workbench sweep', () => {
	it('starts the sweep in one exchange, and reports its state in the next', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-workbench-sweep-live-'));
		const run = join(directory, 'run');
		const workbench = await openWorkbench({ directory: run });
		try {
			await workbench.create('sweep', 'Sweep the series resistor of the LED.');
			await workbench.join('sweep', 'mira');
			await workbench.send(
				'sweep',
				'mira',
				'workbench-live-sweep-start',
				'Fork the firmware-sketch template, clone it, and start the resistor sweep that its README describes. Start it in the background with the name sweep, and do not wait for it to end. Report its handle.',
			);
			await untilSummary(workbench, 'sweep', 1);
			const started = await processesNamed(join(run, 'workspace'), 'sweep');
			expect(started).toHaveLength(1);
			const handle = started[0]?.handle ?? 'none';
			await workbench.send(
				'sweep',
				'mira',
				'workbench-live-sweep-check',
				'What is the state of the resistor sweep? Give its handle, its state, and the last line of its output.',
			);
			const messages = await untilSummary(workbench, 'sweep', 2);
			const summary = messages.filter((message) => message.kind === 'summary').at(-1);
			const text = summary?.kind === 'summary' ? summary.text : '';
			expect(text).toContain(handle);
			expect(text).toMatch(/exited|finished|complete|done|running|rows/i);
			// The files hold the end: the sweep exits 0 within its 30 seconds.
			const deadline = Date.now() + 60_000;
			let ended = await processesNamed(join(run, 'workspace'), 'sweep');
			while (ended[0]?.exit === undefined && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				ended = await processesNamed(join(run, 'workspace'), 'sweep');
			}
			expect(ended[0]?.exit).toMatch(/^0 /);
		} finally {
			await workbench.close();
			await rm(directory, { recursive: true, force: true });
		}
	}, 360_000);
});
