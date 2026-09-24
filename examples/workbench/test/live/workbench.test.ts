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

async function untilSummary(workbench: Workbench, room: string): Promise<readonly Message[]> {
	const deadline = Date.now() + 150_000;
	while (Date.now() < deadline) {
		const { messages } = await workbench.read(room, 0);
		if (messages.some((message) => message.kind === 'summary')) return messages;
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

/** The audit entries of the process tools, from the log of the workspace, oldest first. */
async function processCalls(workspace: string) {
	const text = await readFile(join(workspace, 'workspace', 'audit.jsonl'), 'utf8');
	return text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map(
			(line) =>
				JSON.parse(line) as {
					time: string;
					agent: string;
					tool: string;
					arguments: { name?: string; handle?: string };
					result?: { details?: { process?: { handle: string; state: string } } };
				},
		)
		.filter((entry) => ['bash', 'ps', 'status', 'wait', 'cancel'].includes(entry.tool));
}

/**
 * The answer of the closed exchange `index` to `person`: its summary, or the
 * last message to the person when the exchange closed on a question to them.
 */
async function answerOf(workbench: Workbench, room: string, index: number, person: string) {
	const deadline = Date.now() + 150_000;
	while (Date.now() < deadline) {
		const { messages, exchanges } = await workbench.read(room, 0);
		const exchange = exchanges.filter((one) => one.status === 'closed')[index];
		if (exchange !== undefined && exchange.status === 'closed') {
			if (exchange.summary.status === 'published') return exchange.summary.summary.text;
			const said = messages.filter(
				(message) =>
					message.kind === 'said' && message.seq > exchange.from && message.to === person,
			);
			const last = said.at(-1);
			return last?.kind === 'said' ? last.text : '';
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Exchange ${index} of '${room}' did not close.`);
}

/** Wait until `check` holds, up to `ms`. */
async function until(check: () => Promise<boolean>, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check()) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

/**
 * A parameter sweep from the git template runs in the background. One
 * exchange starts it, and `bash` returns while it runs. After the sweep
 * ends, a later exchange in the same room asks for its state, and the
 * summary gives the end. The assistant runs on Pi, and the design seat on
 * Claude. The audit log shows which process tools each exchange called.
 */
describe.skipIf(!hasKey('pi') || !hasKey('claude'))('Workbench sweep', () => {
	it('starts the sweep in one exchange, and reports its end in the next', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-workbench-sweep-live-'));
		const run = join(directory, 'run');
		const workspace = join(run, 'workspace');
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
			const first = await answerOf(workbench, 'sweep', 0, 'mira');
			const started = await processesNamed(workspace, 'sweep');
			expect(started).toHaveLength(1);
			const handle = started[0]?.handle ?? 'none';
			// The bash call returned while the sweep ran.
			const launch = (await processCalls(workspace)).find(
				(entry) => entry.tool === 'bash' && entry.arguments.name === 'sweep',
			);
			expect(launch?.result?.details?.process).toMatchObject({ handle, state: 'running' });
			// The sweep ends on its own, after the first exchange closed.
			await until(
				async () => (await processesNamed(workspace, 'sweep'))[0]?.exit !== undefined,
				90_000,
			);
			const ended = await processesNamed(workspace, 'sweep');
			expect(ended[0]?.exit).toMatch(/^0 /);
			const before = (await processCalls(workspace)).length;
			await workbench.send(
				'sweep',
				'mira',
				'workbench-live-sweep-check',
				'Is the resistor sweep still running? Give its handle, its state, and the last line of its output.',
			);
			const text = await answerOf(workbench, 'sweep', 1, 'mira').catch(async (error: Error) => {
				const { messages } = await workbench.read('sweep', 0);
				const said = messages.flatMap((message) =>
					message.kind === 'said' || message.kind === 'summary'
						? [`${message.kind} ${message.from}->${message.to ?? 'room'}: ${message.text}`]
						: [],
				);
				process.stdout.write(`live · sweep: the record:\n${said.join('\n')}\n`);
				throw error;
			});
			const checks = (await processCalls(workspace)).slice(before);
			process.stdout.write(
				`live · sweep: first answer: ${first}\n` +
					`live · sweep: bash returned ${launch?.result?.details?.process?.state} for ${handle}\n` +
					`live · sweep: second exchange called ${checks.map((entry) => `${entry.agent}:${entry.tool}(${entry.arguments.handle ?? ''})`).join(', ') || 'no process tool'}\n` +
					`live · sweep: second answer: ${text}\n`,
			);
			expect(text).toContain(handle);
			expect(text).toMatch(/exited|finished|complete|done/i);
			expect(text).not.toMatch(/still running|is running/i);
		} finally {
			await workbench.close();
			await rm(directory, { recursive: true, force: true });
		}
	}, 420_000);
});
