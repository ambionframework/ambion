import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { openWorkbench, type Workbench } from '../../src/workbench.ts';

const model = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
const provider = model.slice(0, model.indexOf('/')).toUpperCase().replace(/-/g, '_');
const keyVariable = `${provider}_API_KEY`;
const live = describe.skipIf(!process.env[keyVariable]);

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

live('Workbench assistant', () => {
	it.each(scenarios)(
		'$name returns a cited summary from a specialist',
		async (scenario) => {
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
		},
		180_000,
	);
});
