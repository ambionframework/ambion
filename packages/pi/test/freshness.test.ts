/**
 * What the provider received of the record. `Freshness` reads the ranges of
 * the record from the exact messages of each provider request, and joins
 * them into the position the activation read through.
 */
import type { AgentMessage, MessageEntry } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, createCustomMessage } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { Freshness, providerMessages, RECORD, recordMessage } from '../src/freshness.ts';
import { diskSessions } from '../src/sessions.ts';
import { tempDir } from './support/temp.ts';

const mark = (after: number, through: number, steer = false) =>
	recordMessage(
		{ after, through, ...(steer ? { steer: true as const } : {}) },
		`${after}..${through}`,
		0,
	);

const user = (text: string): AgentMessage => ({ role: 'user', content: text, timestamp: 0 });

const result = (toolCallId: string): AgentMessage => ({
	role: 'toolResult',
	toolCallId,
	toolName: 'say',
	content: [{ type: 'text', text: 'missed' }],
	isError: true,
	timestamp: 0,
});

describe('freshness', () => {
	it.each([
		['the initial view, at the request that holds it', [[mark(0, 3)]], 3, []],
		['nothing, before a request holds a range', [[]], 0, []],
		[
			'a steer, at the request that holds it',
			[[mark(0, 1)], [mark(0, 1), mark(1, 2, true)]],
			2,
			[2],
		],
		[
			'a range that does not join the position read, while the gap stays open',
			[[mark(0, 1), mark(3, 4, true)]],
			1,
			[4],
		],
		[
			'a range that waited for its gap, once the gap closes',
			[[mark(3, 4, true)], [mark(3, 4, true), mark(0, 3)]],
			4,
			[4, 4],
		],
		['a range seen twice, once', [[mark(0, 2), mark(0, 2)]], 2, []],
		[
			'ranges that both join the position read, the lowest first',
			[[mark(0, 3), mark(0, 2), mark(2, 5)]],
			5,
			[],
		],
		[
			'no user message with the same text, and no custom message of another type',
			[[user('0..5'), createCustomMessage('other', '0..5', false, { after: 0, through: 5 }, 0)]],
			0,
			[],
		],
		[
			'no range with details that are not positions',
			[[createCustomMessage(RECORD, 'x', false, { after: -1, through: 'two' }, 0)]],
			0,
			[],
		],
	] as const)('reads %s', (_name, requests, through, steers) => {
		const freshness = new Freshness();
		const seen = requests.flatMap((request) => freshness.provided([...request]));
		expect(freshness.readThrough).toBe(through);
		expect(seen).toEqual(steers);
	});

	it('starts from the position a continued session read, and never moves back', () => {
		const freshness = new Freshness(5);
		freshness.provided([mark(0, 3)]);
		expect(freshness.readThrough).toBe(5);
		freshness.acknowledgeThrough(4);
		expect(freshness.readThrough).toBe(5);
		freshness.provided([mark(5, 7)]);
		expect(freshness.readThrough).toBe(7);
	});

	it('advances on a tool result only for the call that expects it, once', () => {
		const freshness = new Freshness();
		freshness.toolResultExpected('call-1', 4);
		freshness.provided([result('call-2')]);
		expect(freshness.readThrough).toBe(0);
		freshness.provided([result('call-1')]);
		expect(freshness.readThrough).toBe(4);
		freshness.acknowledgeThrough(6);
		freshness.provided([result('call-1')]);
		expect(freshness.readThrough).toBe(6);
	});

	it('hands a range to the provider as plain user text, and every other message as Pi converts it', () => {
		const assistant = fauxAssistantMessage('Hi.');
		const parts = createCustomMessage(
			RECORD,
			[
				{ type: 'text', text: 'one ' },
				{ type: 'image', data: 'x', mimeType: 'image/png' },
				{ type: 'text', text: 'two' },
			],
			false,
			{ after: 0, through: 1 },
			7,
		);
		const other = createCustomMessage('other', 'shown', false, undefined, 8);
		expect(providerMessages([mark(0, 2), parts, assistant, result('c'), other])).toEqual([
			{ role: 'user', content: '0..2', timestamp: 0 },
			{ role: 'user', content: 'one two', timestamp: 7 },
			assistant,
			result('c'),
			{ role: 'user', content: [{ type: 'text', text: 'shown' }], timestamp: 8 },
		]);
	});

	it('reads the ranges back from a session file after it closes', async () => {
		const sessions = diskSessions(await tempDir('ambion-freshness-'));
		const scope = { room: 'room', seat: 'seat' };
		const written = await sessions.create(scope, 'message:1:seat:1', BACKGROUND_CONTEXT);
		const branch = await written.createBranch('main', null, BACKGROUND_CONTEXT);
		await branch.appendMessage(mark(0, 2), BACKGROUND_CONTEXT);
		await branch.appendMessage(mark(2, 3, true), BACKGROUND_CONTEXT);
		await written.close(BACKGROUND_CONTEXT);

		const read = await sessions.open(scope, 'message:1:seat:1', BACKGROUND_CONTEXT);
		const entries = (await read?.findEntries({ type: 'message' }, BACKGROUND_CONTEXT)) ?? [];
		await read?.close(BACKGROUND_CONTEXT);
		const freshness = new Freshness();
		const steers = freshness.provided(entries.map((entry) => (entry as MessageEntry).message));
		expect(freshness.readThrough).toBe(3);
		expect(steers).toEqual([3]);
	});
});
