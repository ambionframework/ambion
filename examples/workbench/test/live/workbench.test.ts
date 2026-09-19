import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWorkbench } from '../../src/server.ts';

const model = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
const provider = model.slice(0, model.indexOf('/')).toUpperCase().replace(/-/g, '_');
const keyVariable = `${provider}_API_KEY`;
const live = describe.skipIf(!process.env[keyVariable]);

interface Message {
	seq?: number;
	kind: string;
	from?: string;
	to?: string;
	text?: string;
}

interface Delivery {
	from: number;
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

live('Workbench assistant', () => {
	it.each(scenarios)(
		'$name returns a cited summary from a specialist',
		async (scenario) => {
			const directory = await mkdtemp(join(tmpdir(), `ambion-workbench-${scenario.name}-live-`));
			const workbench = await openWorkbench(join(directory, 'run'), 'start');
			try {
				await listen(workbench);
				const address = workbench.server.address();
				if (!address || typeof address === 'string') throw new Error('The server has no address.');
				const base = `http://127.0.0.1:${address.port}`;
				const path = `/rooms/${scenario.name}/humans/${scenario.person}`;
				expect((await request(base, path, { method: 'PUT' })).status).toBe(200);
				const sent = await request(base, path, {
					method: 'POST',
					body: JSON.stringify({ key: `workbench-live-${scenario.name}`, text: scenario.request }),
				});
				expect(sent.status).toBe(202);
				const delivery = (await sent.json()) as Delivery;
				const messages = await untilSummary(base, scenario.name, delivery.from);
				const summary = messages.find((message) => message.kind === 'summary');
				expect(summary).toMatchObject({ kind: 'summary', from: 'assistant', to: scenario.person });
				expect(
					messages.some((message) => message.from && scenario.specialists.includes(message.from)),
				).toBe(true);
				scenario.summaryCheck(summary?.text ?? '');
			} finally {
				await workbench.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
		180_000,
	);
});

async function listen(workbench: Awaited<ReturnType<typeof openWorkbench>>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		workbench.server.once('error', reject);
		workbench.server.listen(0, '127.0.0.1', () => resolve());
	});
}

async function request(base: string, path: string, init: RequestInit): Promise<Response> {
	return fetch(`${base}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
	});
}

async function untilSummary(base: string, room: string, from: number): Promise<Message[]> {
	const deadline = Date.now() + 150_000;
	while (Date.now() < deadline) {
		const response = await request(base, `/rooms/${room}/messages?since=${from - 1}`, {});
		const messages = (await response.json()) as Message[];
		if (messages.some((message) => message.kind === 'summary')) return messages;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`The Workbench did not publish a summary for '${room}'.`);
}
