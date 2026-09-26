/**
 * The tools that the Pi executor binds to one activation: which tools each
 * purpose gets, what a say or a membership tool commits, and what a domain
 * tool receives.
 */
import { defineAgent, defineTool, type ToolContext } from '@ambionframework/ambion';
import type {
	ActivationSpec,
	ActivationView,
	CommitRequest,
	CommitResult,
	Intent,
} from '@ambionframework/ambion/hosting';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import type { Entry } from '../../ambion/src/journal/journal.ts';
import { activationSpec } from '../../ambion/src/room/activation.ts';
import { projectState, replay } from '../../ambion/src/room/projection.ts';
import { viewOf } from '../../ambion/src/room/view.ts';
import { pi } from '../src/index.ts';
import { binding, type PiTool, toolsFor } from '../src/tools.ts';
import { activationFor, roomThatCommits, unusedRoom, viewFor } from './support/activation.ts';

/** What the domain tool received, one context per call. */
const seen: ToolContext[] = [];

const worker = defineAgent({
	name: 'worker',
	identity: 'Works on room decisions.',
	executor: pi({
		instructions: 'Use the tool that the room gives you.',
		model: 'scripted/assistant',
		tools: [
			defineTool({
				name: 'record_decision',
				description: 'Record a private decision.',
				parameters: Type.Object({}),
				execute: (_params, context) => {
					seen.push(context);
					return 'recorded';
				},
			}),
		],
	}),
});

// @ts-expect-error The room has no summary intent; closing work uses said.
const removedSummaryIntent: Intent = { kind: 'summary', text: 'x' };
void removedSummaryIntent;

const oldAuthority: ActivationSpec = {
	id: 'message:4:worker:1',
	seat: 'worker',
	attempt: 1,
	purpose: { kind: 'respond', message: 4 },
	// @ts-expect-error Activation authority no longer carries a grant field.
	grant: { kind: 'say', tool: 'say' },
};
void oldAuthority;

type Purpose = ActivationView['spec']['purpose'];
const respond: Purpose = { kind: 'respond', message: 4 };
const summarize: Purpose = {
	kind: 'summarize',
	exchange: 4,
	person: 'priya',
	people: ['priya'],
	through: 7,
};

const at = '2026-01-01T00:00:00.000Z';
const blank = 'The message is empty. Say something, or end your turn instead.';
const said = (seq: number, text: string): CommitResult => ({
	committed: { kind: 'said', seq, at, from: 'worker', text },
});

/**
 * The tools of one activation over a room that records each commit. The room
 * answers each commit with the next of `answers`, and the last one repeats.
 */
function bound(id: string, purpose: Purpose, ...answers: CommitResult[]) {
	const commits: CommitRequest[] = [];
	const activation = activationFor(id, worker);
	let next = 0;
	const room = roomThatCommits(commits, () => {
		const answer = answers[Math.min(next, answers.length - 1)] ?? said(5, 'x');
		next += 1;
		return answer;
	});
	const tools = toolsFor(viewFor(purpose), worker, binding(activation, room));
	const tool = (index: number): PiTool => {
		const found = tools[index];
		if (found === undefined) throw new Error(`The purpose has no tool at ${index}.`);
		return found;
	};
	return { activation, commits, tools, say: tool(0), tool };
}

const names = (tools: readonly PiTool[]) => tools.map((tool) => tool.name);

/** One call of a harness tool, as the harness makes it. */
const invocation = {
	invocationId: 'invocation',
	operationId: 'operation',
	turnId: 'turn',
	getMemo: async () => undefined,
	setMemo: async () => {},
};
const call = (tool: PiTool | undefined, id: string, params: Record<string, unknown>) => {
	if (tool === undefined) throw new Error('No tool.');
	return tool.execute(id, params, () => {}, undefined, invocation, BACKGROUND_CONTEXT);
};

describe('executor tool authority', () => {
	it('binds only the tool named by each activation purpose', () => {
		expect(names(bound('activation', respond).tools)).toEqual([
			'say',
			'seat',
			'unseat',
			'dismiss',
			'record_decision',
		]);
		expect(names(bound('activation', summarize).tools)).toEqual(['say']);
	});

	it('keeps a refused blank open, then accepts a corrected retry under the same key', async () => {
		const { activation, commits, say } = bound(
			'message:0:worker:1',
			{ kind: 'respond', message: 0 },
			{ refused: blank },
			said(1, 'A useful answer.'),
		);
		await expect(call(say, 'same-key', { text: '   ' })).rejects.toThrow(blank);
		expect(activation.readThrough).toBe(0);
		await expect(call(say, 'same-key', { text: '  A useful answer.  ' })).resolves.toMatchObject({
			content: [{ text: 'delivered' }],
		});
		expect(activation.cancelled).toBe(false);
		expect(activation.readThrough).toBe(1);
		expect(commits.map(({ key, intent }) => ({ key, intent }))).toEqual([
			{ key: 'same-key', intent: { kind: 'said', text: '' } },
			{ key: 'same-key', intent: { kind: 'said', text: 'A useful answer.' } },
		]);
	});

	it('sends summary text only, lets the room stamp recipient and range, and terminates once it lands', async () => {
		const { activation, commits, say } = bound(
			'closed:4:worker:1',
			summarize,
			{ refused: blank },
			said(5, 'The room stamped this.'),
		);
		await expect(call(say, 'closing-key', { to: 'priya', text: ' \t' })).rejects.toThrow(blank);
		const result = await call(say, 'closing-key', {
			to: ' priya ',
			text: '  The exchange is complete.  ',
		});
		expect(result.content).toEqual([{ type: 'text', text: 'delivered' }]);
		expect(result.terminate).toBe(true);
		const request = (text: string) => ({
			activation: 'closed:4:worker:1',
			key: 'closing-key',
			intent: { kind: 'said', to: 'priya', text },
		});
		expect(commits).toEqual([request(''), request('The exchange is complete.')]);
		expect(activation.cancelled).toBe(false);
		expect(activation.readThrough).toBe(0);
	});

	it.each([
		['respond', 'message:4:worker:1', respond],
		['summarize', 'closed:4:worker:1', summarize],
	] as const)(
		'passes trimmed refs from the %s say tool into the intent',
		async (_kind, id, purpose) => {
			const { commits, say } = bound(id, purpose, said(5, 'x'));
			await call(say, 'c1', { text: 'x', refs: [' https://x/a ', '', 'https://x/b'] });
			await call(say, 'c2', { text: 'x', refs: [] });
			await call(say, 'c3', { text: 'x', refs: ['  '] });
			expect(commits.map((commit) => commit.intent)).toEqual([
				{ kind: 'said', text: 'x', refs: ['https://x/a', 'https://x/b'] },
				{ kind: 'said', text: 'x' },
				{ kind: 'said', text: 'x' },
			]);
		},
	);

	it('does not mark context consumed for membership or an unchanged membership result', async () => {
		const { activation, commits, tool } = bound('message:4:worker:1', respond, {
			unchanged: { kind: 'seated', name: 'surveyor' },
		});
		await expect(call(tool(1), 'seat-call', { name: 'surveyor' })).resolves.toMatchObject({
			content: [{ text: 'delivered' }],
		});
		expect(commits).toEqual([
			{
				activation: 'message:4:worker:1',
				key: 'seat-call',
				intent: { kind: 'seated', name: 'surveyor' },
			},
		]);
		expect(activation.readThrough).toBe(0);
	});

	it('acknowledges a live response boundary but fixes a summary at its close', () => {
		const at = '2026-01-01T00:00:00.000Z';
		const entries: Entry[] = [
			{
				kind: 'composition',
				seq: 1,
				body: {
					version: 2,
					summary: 'worker',
					agents: [
						{ name: 'worker', identity: 'A.', attention: 'broadcast' },
						{ name: 'product', identity: 'P.', attention: 'broadcast' },
					],
					available: [],
					at,
				},
			},
			{
				kind: 'message',
				seq: 2,
				body: { kind: 'arrived', at, subject: 'priya', identity: 'P.' },
			},
			{
				kind: 'message',
				seq: 3,
				body: { kind: 'said', at, from: 'priya', text: 'Question.' },
			},
			{
				kind: 'close',
				seq: 4,
				body: { owner: 'priya', from: 3, through: 3, at, summary: 'worker' },
			},
			{
				kind: 'message',
				seq: 5,
				body: { kind: 'said', at, from: 'priya', text: 'Later.', wakes: ['product'] },
			},
			{
				kind: 'message',
				seq: 6,
				body: { kind: 'said', at, from: 'priya', text: 'Latest.', wakes: ['product'] },
			},
		];
		const state = projectState(replay(entries, { backoff: () => 0 }));
		const facts = {
			name: 'room',
			now: Date.parse(at),
			state,
			live: new Map<string, string[]>(),
			messagesSince: () => 0,
		};
		const summary = activationSpec('closed:3:worker:1', state);
		const response = activationSpec('message:5:product:1', state);
		if (summary === undefined || response === undefined)
			throw new Error('Expected valid authorities.');

		const summaryView = viewOf(summary, facts);
		const responseView = viewOf(response, facts);
		expect(summaryView.through).toBe(3);
		expect(summaryView.context.messages).not.toContainEqual(
			expect.objectContaining({ text: 'Latest.' }),
		);
		expect(responseView.through).toBe(6);
		expect(responseView.context.messages).toContainEqual(
			expect.objectContaining({ text: 'Latest.' }),
		);
	});

	it('hands a domain tool the room, the activation, and the exchange from the view', async () => {
		const base = viewFor(respond, 4);
		const open: ActivationView = {
			...base,
			spec: { ...base.spec, id: 'message:4:worker:1' },
			context: { ...base.context, exchange: { owner: 'priya', from: 4 } },
		};
		const held = binding(activationFor('message:4:worker:1', worker), unusedRoom);
		await call(toolsFor(open, worker, held).at(-1), 'call-1', {});
		await call(
			toolsFor({ ...open, context: { ...base.context } }, worker, held).at(-1),
			'call-2',
			{},
		);

		const [first, second] = seen;
		expect(first).toMatchObject({
			callId: 'call-1',
			room: 'room',
			activation: 'message:4:worker:1',
			exchange: { owner: 'priya', from: 4 },
		});
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first?.exchange)).toBe(true);
		expect(second).toMatchObject({ room: 'room', activation: 'message:4:worker:1' });
		expect(second).not.toHaveProperty('exchange');
	});
});
