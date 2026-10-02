/**
 * The tools that the Pi executor binds to one activation: which tools each
 * purpose gets, what a say or a membership tool commits, and what a domain
 * tool receives.
 */
import {
	defineAgent,
	defineTool,
	type Message,
	type Step,
	type ToolContext,
} from '@ambionframework/ambion';
import type {
	ActivationSpec,
	ActivationView,
	CommitRequest,
	CommitResult,
	Intent,
	RoomProtocol,
} from '@ambionframework/ambion/hosting';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { ROOM_TOOL_NAMES } from '../../ambion/src/define.ts';
import type { RoomEntry } from '../../ambion/src/journal/journal.ts';
import { activationSpec } from '../../ambion/src/room/activation.ts';
import { projectState, replay } from '../../ambion/src/room/projection.ts';
import { viewOf } from '../../ambion/src/room/view.ts';
import { pi } from '../src/index.ts';
import { type PiTool, toolsFor, UNBOUNDED } from '../src/tools.ts';
import {
	boundActivation,
	roomThatCommits,
	toolApi,
	unusedRoom,
	viewFor,
} from './support/activation.ts';
import { noTrace } from './support/trace.ts';

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
				label: 'Record decision',
				executionMode: 'sequential',
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
const blank = 'The message is empty. Say something, or end your activation instead.';
const said = (seq: number, text: string): CommitResult => ({
	committed: { kind: 'said', seq, at, from: 'worker', text },
});

/**
 * The tools of one activation over a room that records each commit. The room
 * answers each commit with the next of `answers`, and the last one repeats.
 */
async function bound(id: string, purpose: Purpose, ...answers: CommitResult[]) {
	const commits: CommitRequest[] = [];
	let next = 0;
	const room = roomThatCommits(commits, () => {
		const answer = answers[Math.min(next, answers.length - 1)] ?? said(5, 'x');
		next += 1;
		return answer;
	});
	const view = viewFor(purpose);
	const { state: activation, tools: bound } = await boundActivation(id, worker, room, view);
	const tools = toolsFor(view, worker, bound, noTrace);
	const tool = (index: number): PiTool => {
		const found = tools[index];
		if (found === undefined) throw new Error(`The purpose has no tool at ${index}.`);
		return found;
	};
	return { activation, commits, tools, say: tool(0), tool };
}

const names = (tools: readonly PiTool[]) => tools.map((tool) => tool.name);

/** One call of a tool registration, with the call id and the output sink the harness gives it. */
const call = (tool: PiTool | undefined, id: string, params: Record<string, unknown>) => {
	if (tool === undefined) throw new Error('No tool.');
	return tool.execute(params, toolApi(id), BACKGROUND_CONTEXT);
};

/** The result of a tool that failed: the text the model reads. */
const refused = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });

describe('executor tool authority', () => {
	it('binds only the tool named by each activation purpose', async () => {
		const { tools } = await bound('activation', respond);
		expect(names(tools)).toEqual([
			'say',
			'schedule',
			'seat',
			'unseat',
			'dismiss',
			'recall',
			'record_decision',
		]);
		// The room tools are exactly the names that `defineAgent` refuses for a definition tool.
		expect(new Set(names(tools).slice(0, -1))).toEqual(new Set(ROOM_TOOL_NAMES));
		// Pi builds the tool of the definition from its `AmbionTool`. A `BoundTool` has no execution mode.
		expect(tools.at(-1)).toMatchObject({ executionMode: 'sequential' });
		// Every tool owns the size of its result: pi-durable bounds none of it.
		for (const tool of tools) expect(tool.outputLimits).toEqual(UNBOUNDED);
		expect(names((await bound('activation', summarize)).tools)).toEqual(['say']);
	});

	it('keeps a refused blank open, then accepts a corrected retry under the same key', async () => {
		const { activation, commits, say } = await bound(
			'message:0:worker:1',
			{ kind: 'respond', message: 0 },
			{ refused: blank },
			said(1, 'A useful answer.'),
		);
		await expect(call(say, 'same-key', { text: '   ' })).resolves.toEqual(refused(blank));
		expect(activation.readThrough).toBe(0);
		await expect(call(say, 'same-key', { text: '  A useful answer.  ' })).resolves.toMatchObject({
			content: [{ text: 'said #1' }],
		});
		expect(activation.isCut).toBe(false);
		expect(activation.readThrough).toBe(1);
		expect(commits.map(({ key, intent }) => ({ key, intent }))).toEqual([
			{ key: 'same-key', intent: { kind: 'said', text: '' } },
			{ key: 'same-key', intent: { kind: 'said', text: 'A useful answer.' } },
		]);
	});

	it('sends summary text only, lets the room stamp recipient and range, and terminates once it lands', async () => {
		const { activation, commits, say } = await bound(
			'closed:4:worker:1',
			summarize,
			{ refused: blank },
			said(5, 'The room stamped this.'),
		);
		await expect(call(say, 'closing-key', { to: 'priya', text: ' \t' })).resolves.toEqual(
			refused(blank),
		);
		const result = await call(say, 'closing-key', {
			to: ' priya ',
			text: '  The exchange is complete.  ',
		});
		expect(result.content).toEqual([{ type: 'text', text: 'said #5' }]);
		expect(result.control).toEqual({ terminate: true });
		const request = (text: string) => ({
			activation: 'closed:4:worker:1',
			key: 'closing-key',
			intent: { kind: 'said', to: 'priya', text },
		});
		expect(commits).toEqual([request(''), request('The exchange is complete.')]);
		expect(activation.isCut).toBe(false);
		expect(activation.readThrough).toBe(0);
	});

	it.each([
		['respond', 'message:4:worker:1', respond],
		['summarize', 'closed:4:worker:1', summarize],
	] as const)(
		'passes trimmed refs from the %s say tool into the intent',
		async (_kind, id, purpose) => {
			const { commits, say } = await bound(id, purpose, said(5, 'x'));
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

	it('schedules a say to the seat, and confirms the read position only when nothing landed before it', async () => {
		const scheduled = (seq: number): Message => ({
			kind: 'said',
			seq,
			at,
			from: 'worker',
			to: 'worker',
			text: 'Check the build.',
			delaySeconds: 600,
		});
		const clean = await bound('message:4:worker:1', respond, { committed: scheduled(5) });
		const result = await call(clean.tool(1), 'clean', {
			text: ' Check the build. ',
			delaySeconds: 600,
		});
		expect(result.content).toEqual([
			{
				type: 'text',
				text: 'scheduled #5: the room wakes you with this message at 2026-01-01T00:10:00.000Z',
			},
		]);
		expect(clean.commits).toEqual([
			{
				activation: 'message:4:worker:1',
				key: 'clean',
				readThrough: 0,
				intent: { kind: 'said', to: 'worker', text: 'Check the build.', delaySeconds: 600 },
			},
		]);
		expect(clean.activation.readThrough).toBe(5);

		const unread: Message = { kind: 'said', seq: 5, at, from: 'priya', text: 'Also the tests.' };
		const behind = await bound('message:4:worker:1', respond, {
			committed: scheduled(6),
			unread: [unread],
		});
		const late = await call(behind.tool(1), 'behind', {
			text: 'Check the build.',
			delaySeconds: 600,
		});
		expect(late.content).toEqual([
			{
				type: 'text',
				text: [
					'scheduled #6: the room wakes you with this message at 2026-01-01T00:10:00.000Z. New on the record before it:',
					'#5 [priya] Also the tests.',
				].join('\n'),
			},
		]);
		// The model reads the record through the say when it reads the result.
		expect(behind.activation.readThrough).toBe(0);
	});

	it('recalls messages of the room by URI, one line for each ref, and moves no read position', async () => {
		const record: Message[] = [
			{ kind: 'said', seq: 2, at, from: 'priya', text: 'Is the pour on?' },
			{ kind: 'said', seq: 5, at, from: 'worker', to: 'priya', text: 'Yes, at nine.' },
		];
		const reads: (number | undefined)[] = [];
		const room: RoomProtocol = {
			...unusedRoom,
			// The view of one message, as the room serves it.
			view: async (_id, seq) => {
				reads.push(seq);
				const one = record.filter((message) => message.seq === seq);
				const view = viewFor(respond);
				return { view: { ...view, context: { ...view.context, messages: one } } };
			},
		};
		const view = viewFor(respond);
		const { state: activation, tools } = await boundActivation(
			'message:4:worker:1',
			worker,
			room,
			view,
		);
		const recall = toolsFor(view, worker, tools, noTrace).find((tool) => tool.name === 'recall');
		const uri = (seq: number) => `ambion://room/room/message/${seq}`;
		// Every ref finds its message: a success, one line for each distinct ref. A seq as the
		// record shows it names a message of this room.
		const result = await call(recall, 'recall', { refs: [uri(5), ' #2 ', uri(5)] });
		expect(result.content).toEqual([
			{ type: 'text', text: '#5 [worker → priya] Yes, at nine.\n#2 [priya] Is the pour on?' },
		]);
		// A ref that finds nothing fails the call, and each line says why.
		await expect(
			call(recall, 'misses', {
				refs: ['2', uri(4), 'ambion://room/elsewhere/message/2', 'ambion://room/room', 'file:///x'],
			}),
		).resolves.toEqual(
			refused(
				[
					'#2 [priya] Is the pour on?',
					`${uri(4)}: no message at #4 on the record you may read. Take the seq from a record line or a ref.`,
					'ambion://room/elsewhere/message/2: names another room. recall reads this room alone.',
					'ambion://room/room: not a message ref. Give the seq as #12, or the URI ambion://room/room/message/<seq>.',
					'file:///x: not a message ref. Give the seq as #12, or the URI ambion://room/room/message/<seq>.',
				].join('\n'),
			),
		);
		// Each distinct seq is one view, and a recalled message is old: nothing moves the position.
		expect(reads).toEqual([5, 2, 2, 4]);
		expect(activation.readThrough).toBe(0);
		await expect(call(recall, 'none', { refs: [] })).resolves.toMatchObject({
			isError: true,
			content: [{ text: expect.stringMatching(/refs must be 1 to 16/) }],
		});
	});

	it('does not mark context consumed for membership or an unchanged membership result', async () => {
		const { activation, commits, tool } = await bound('message:4:worker:1', respond, {
			unchanged: { kind: 'seated', name: 'surveyor' },
		});
		await expect(call(tool(2), 'seat-call', { name: 'surveyor' })).resolves.toMatchObject({
			content: [{ text: 'surveyor is already seated' }],
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
		const entries: RoomEntry[] = [
			{
				kind: 'composition',
				seq: 1,
				body: {
					summaryWriter: 'worker',
					seated: [
						{ name: 'worker', identity: 'A.', attention: 'broadcast' },
						{ name: 'product', identity: 'P.', attention: 'broadcast' },
					],
					reserve: [],
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
				body: { person: 'priya', from: 3, through: 3, at, summaryWriter: 'worker' },
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
			context: { ...base.context, exchange: { person: 'priya', from: 4 } },
		};
		const recorded: Step[] = [];
		const sink = { record: (step: Step) => void recorded.push(step) };
		await call(toolsFor(open, worker, [], sink).at(-1), 'call-1', {});
		await call(
			toolsFor({ ...open, context: { ...base.context } }, worker, [], sink).at(-1),
			'call-2',
			{},
		);

		const [first, second] = seen;
		expect(first).toMatchObject({
			callId: 'call-1',
			room: 'room',
			activation: 'message:4:worker:1',
			exchange: { person: 'priya', from: 4 },
		});
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first?.exchange)).toBe(true);
		expect(second).toMatchObject({ room: 'room', activation: 'message:4:worker:1' });
		expect(second).not.toHaveProperty('exchange');
		// The sink of the activation reaches no tool but compose, and the context holds no function.
		expect(recorded).toEqual([]);
		const functions = Object.entries(first ?? {}).filter(
			([, value]) => typeof value === 'function',
		);
		expect(functions.map(([key]) => key)).toEqual(['onUpdate']);
	});
});
