import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDemo } from '../../src/server.ts';

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
	subject?: string;
}

interface Delivery {
	from: number;
}

interface Scenario {
	name: string;
	person: string;
	request: string;
	specialists: string[];
	artifact?: string;
	artifactCheck?: (text: string) => void;
	messageCheck: (messages: Message[]) => void;
}

const scenarios: readonly Scenario[] = [
	{
		name: 'design',
		person: 'alice',
		request: 'Read feedback.md. Compare the priorities and record one focused milestone decision.',
		specialists: ['planner'],
		artifact: '/shared/brief.md',
		artifactCheck: (text) => {
			expect(text).not.toContain('Status: awaiting a product decision.');
			expect(text).not.toMatch(
				/prototype(?:\.html)?\s+(?:is\s+)?(?:absent|missing|does not exist)/i,
			);
		},
		messageCheck: (messages) => {
			expect(saidBy(messages, ['planner'])).not.toHaveLength(0);
			expect(messages.find((message) => message.kind === 'summary')?.text).not.toMatch(
				/prototype(?:\.html)?\s+(?:is\s+)?(?:absent|missing|does not exist)/i,
			);
		},
	},
	{
		name: 'delivery',
		person: 'bob',
		request:
			'Inspect prototype.html. Make the smallest useful overdue or mobile improvement, then report actual files and verification.',
		specialists: ['builder'],
		artifact: '/shared/prototype.html',
		artifactCheck: (text) => {
			expect(text).toMatch(/<html/i);
			expect(text).toMatch(/overdue|mobile|width/i);
		},
		messageCheck: (messages) => expect(saidBy(messages, ['builder'])).not.toHaveLength(0),
	},
	{
		name: 'launch',
		person: 'cara',
		request:
			'Read the brief and prototype. Draft accurate release notes and flag any needed decision.',
		specialists: ['writer'],
		artifact: '/shared/launch.md',
		artifactCheck: (text) => expect(text).not.toContain('Status: not written.'),
		messageCheck: (messages) => {
			expect(saidBy(messages, ['writer'])).not.toHaveLength(0);
			expect(messages.find((message) => message.kind === 'summary')?.text).not.toMatch(
				/\b(?:prototype|features?|changes?|milestone|release|it|we)\s+(?:is|are|was|were|has been|have been|already)\s+(?:shipped|deployed|released)\b/i,
			);
		},
	},
	{
		name: 'triage',
		person: 'cara',
		request:
			'Bring in writer to handle R-19 only. Draft exactly two sentences explaining the current reminder capability. Do not edit any files.',
		specialists: ['planner', 'builder', 'writer', 'reviewer'],
		messageCheck: (messages) => {
			expect(
				messages.some((message) => message.kind === 'seated' && message.subject !== 'assistant'),
			).toBe(true);
			const summary = messages.find((message) => message.kind === 'summary');
			expect(summary?.text).toMatch(/R-19/);
			expect(summary?.text).not.toMatch(/email (?:was|has been) sent/i);
		},
	},
];

live('Relay assistant', () => {
	it.each(scenarios)(
		'$name produces the expected shared result',
		async (scenario) => {
			const directory = await mkdtemp(join(tmpdir(), `ambion-relay-${scenario.name}-live-`));
			const demo = await openDemo(join(directory, 'demo'), 'start');
			try {
				await prepareBrief(directory, scenario.name);
				await listen(demo);
				const address = demo.server.address();
				if (!address || typeof address === 'string') throw new Error('The server has no address.');
				const base = `http://127.0.0.1:${address.port}`;
				const path = `/rooms/${scenario.name}/humans/${scenario.person}`;
				const original =
					scenario.artifact === undefined
						? undefined
						: await readWorkspace(base, scenario.artifact);
				const originalWorkspace =
					scenario.name === 'triage' ? await snapshotWorkspace(base) : undefined;
				expect((await request(base, path, { method: 'PUT' })).status).toBe(200);
				const sent = await request(base, path, {
					method: 'POST',
					body: JSON.stringify({ key: `relay-live-${scenario.name}`, text: scenario.request }),
				});
				expect(sent.status).toBe(202);
				const delivery = (await sent.json()) as Delivery;
				const messages = await untilSummary(base, scenario.name, delivery.from);
				const summary = messages.find((message) => message.kind === 'summary');
				expect(summary).toMatchObject({ kind: 'summary', from: 'assistant', to: scenario.person });
				expect(
					messages.some((message) => message.from && scenario.specialists.includes(message.from)),
				).toBe(true);
				scenario.messageCheck(messages);
				if (originalWorkspace !== undefined)
					expect(await snapshotWorkspace(base)).toEqual(originalWorkspace);
				if (scenario.artifact !== undefined && scenario.artifactCheck !== undefined) {
					const artifact = await readWorkspace(base, scenario.artifact);
					expect(artifact.status).toBe(200);
					expect(artifact.text.trim()).not.toBe('');
					expect(artifact.text).not.toBe(original?.text);
					scenario.artifactCheck(artifact.text);
				}
			} finally {
				await demo.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
		180_000,
	);

	it('uses one directed writer activation for a human revision', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-relay-launch-revision-live-'));
		const demo = await openDemo(join(directory, 'demo'), 'start');
		try {
			await prepareBrief(directory, 'launch');
			await listen(demo);
			const address = demo.server.address();
			if (!address || typeof address === 'string') throw new Error('The server has no address.');
			const base = `http://127.0.0.1:${address.port}`;
			const path = '/rooms/launch/humans/cara';
			expect((await request(base, path, { method: 'PUT' })).status).toBe(200);
			const first = await request(base, path, {
				method: 'POST',
				body: JSON.stringify({
					key: 'relay-live-launch-revision-first',
					text: 'Draft accurate release notes from the current prototype and brief.',
				}),
			});
			expect(first.status).toBe(202);
			const firstDelivery = (await first.json()) as Delivery;
			await untilSummary(base, 'launch', firstDelivery.from);
			const beforeRevision = await readWorkspace(base, '/shared/launch.md');
			const second = await request(base, path, {
				method: 'POST',
				body: JSON.stringify({
					key: 'relay-live-launch-revision-second',
					text: "Revise the draft: change the opening sentence to exactly 'Relay keeps handoffs visible.' and keep the draft under 100 words.",
				}),
			});
			expect(second.status).toBe(202);
			const secondDelivery = (await second.json()) as Delivery;
			const messages = await untilSummary(base, 'launch', secondDelivery.from);
			const writerActivations = messages.filter(
				(message) =>
					message.seq !== undefined &&
					message.seq >= secondDelivery.from &&
					message.kind === 'said' &&
					message.from === 'assistant' &&
					message.to === 'writer',
			);
			expect(writerActivations).toHaveLength(1);
			const afterRevision = await readWorkspace(base, '/shared/launch.md');
			expect(afterRevision.text).not.toBe(beforeRevision.text);
			expect(afterRevision.text).toContain('Relay keeps handoffs visible.');
			expect(afterRevision.text.trim().split(/\s+/u).length).toBeLessThan(100);
		} finally {
			await demo.close();
			await rm(directory, { recursive: true, force: true });
		}
	}, 180_000);

	it('reactivates a specialist for a renewed request despite an existing draft', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-relay-triage-renewed-live-'));
		const demo = await openDemo(join(directory, 'demo'), 'start');
		try {
			await listen(demo);
			const address = demo.server.address();
			if (!address || typeof address === 'string') throw new Error('The server has no address.');
			const base = `http://127.0.0.1:${address.port}`;
			const path = '/rooms/triage/humans/cara';
			await writeFile(
				join(directory, 'demo', 'workspace', 'shared', 'response-R-19.md'),
				'Relay does not send reminder emails. Check the board for current handoff status.\n',
			);
			const unchanged = await snapshotWorkspace(base);
			expect((await request(base, path, { method: 'PUT' })).status).toBe(200);
			const first = await request(base, path, {
				method: 'POST',
				body: JSON.stringify({
					key: 'relay-live-triage-renewed-first',
					text: 'Bring in the writer for R-19 only. Draft exactly two sentences about the current reminder capability. Do not edit any files.',
				}),
			});
			expect(first.status).toBe(202);
			const firstDelivery = (await first.json()) as Delivery;
			await untilSummary(base, 'triage', firstDelivery.from);
			const removal = await request(base, path, {
				method: 'POST',
				body: JSON.stringify({
					key: 'relay-live-triage-renewed-remove',
					text: 'Unseat writer now. No further specialist work and no file edits.',
				}),
			});
			expect(removal.status).toBe(202);
			const removalDelivery = (await removal.json()) as Delivery;
			const removed = await untilSummary(base, 'triage', removalDelivery.from);
			expect(removed).toEqual(
				expect.arrayContaining([expect.objectContaining({ kind: 'unseated', subject: 'writer' })]),
			);
			const second = await request(base, path, {
				method: 'POST',
				body: JSON.stringify({
					key: 'relay-live-triage-renewed-second',
					text: 'Bring in the writer for R-19 only. Draft exactly two sentences about the current reminder capability. Do not edit any files.',
				}),
			});
			expect(second.status).toBe(202);
			const secondDelivery = (await second.json()) as Delivery;
			const messages = await untilSummary(base, 'triage', secondDelivery.from);
			expect(messages).toEqual(
				expect.arrayContaining([expect.objectContaining({ kind: 'seated', subject: 'writer' })]),
			);
			expect(
				messages.some(
					(message) =>
						message.seq !== undefined &&
						message.seq >= secondDelivery.from &&
						message.kind === 'said' &&
						message.from === 'writer',
				),
			).toBe(true);
			expect(await snapshotWorkspace(base)).toEqual(unchanged);
		} finally {
			await demo.close();
			await rm(directory, { recursive: true, force: true });
		}
	}, 180_000);
});

/** Each independent scenario starts at its place in the product sequence. */
async function prepareBrief(directory: string, scenario: string): Promise<void> {
	const briefs: Record<string, string> = {
		delivery:
			'# Agreed milestone\n\nStatus: approved by Alice.\nImplement overdue visibility and mobile readability in the static handoff board. Scope: one week, focused HTML/CSS changes, no email service or backend. Verify the changes against the local prototype.\n',
		launch:
			'# Approved release scope\n\nStatus: approved by Alice for a draft about the current prototype.\nThis initial preview contains the existing static handoff table with owners, due dates, and statuses. Overdue highlighting, mobile improvements, reminders, and a backend are future work. Draft release notes from the existing implementation; no additional product decision or implementation is required for this draft.\n',
	};
	const brief = briefs[scenario];
	if (brief !== undefined) {
		await writeFile(join(directory, 'demo', 'workspace', 'shared', 'brief.md'), brief);
	}
}

async function snapshotWorkspace(base: string): Promise<Record<string, string>> {
	const listed = await request(base, '/workspace', {});
	const files = (await listed.json()) as { files: { path: string }[] };
	const entries = await Promise.all(
		files.files.map(async ({ path }) => {
			const file = await readWorkspace(base, path);
			return [path, file.text] as const;
		}),
	);
	return Object.fromEntries(entries);
}

async function listen(demo: Awaited<ReturnType<typeof openDemo>>): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		demo.server.once('error', reject);
		demo.server.listen(0, '127.0.0.1', () => resolve());
	});
}

async function request(base: string, path: string, init: RequestInit): Promise<Response> {
	return fetch(`${base}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
	});
}

async function readWorkspace(
	base: string,
	path: string,
): Promise<{ status: number; text: string }> {
	const response = await request(base, `/file?path=${encodeURIComponent(path)}`, {});
	const body = (await response.json()) as { text?: string };
	return { status: response.status, text: body.text ?? '' };
}

async function untilSummary(base: string, room: string, from: number): Promise<Message[]> {
	const deadline = Date.now() + 150_000;
	while (Date.now() < deadline) {
		const response = await request(base, `/rooms/${room}/messages?since=${from - 1}`, {});
		const messages = (await response.json()) as Message[];
		if (messages.some((message) => message.kind === 'summary')) return messages;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`Relay did not publish a summary for '${room}'.`);
}

function saidBy(messages: readonly Message[], names: readonly string[]): Message[] {
	return messages.filter(
		(message) => message.kind === 'said' && message.from && names.includes(message.from),
	);
}
