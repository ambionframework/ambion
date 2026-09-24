/**
 * Room URIs and refs: the pure rules, and the refs a said and a summary carry
 * through a room, a restart, and a read.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	AmbionError,
	createRuntime,
	defineHuman,
	isSpoken,
	isSummary,
	type Message,
	messageUri,
	parseRoomUri,
	readExchange,
	readRoom,
	resumeRoom,
	roomUri,
	startRoom,
} from '../src/index.ts';
import { isRef, REF_LIMITS, refsRefusal } from '../src/refs.ts';
import { assistant, collect, roomName, scriptedAgent } from './support/room.ts';
import { byAgent, callTool, isClosing, quiet, scripted } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { storages } from './support/storage.ts';

describe('room URIs', () => {
	it('round-trips a room and a message', () => {
		expect(roomUri('site')).toBe('ambion://room/site');
		expect(messageUri('site', 12)).toBe('ambion://room/site/message/12');
		expect(parseRoomUri(roomUri('site'))).toEqual({ room: 'site' });
		expect(parseRoomUri(messageUri('site', 12))).toEqual({ room: 'site', message: 12 });
	});

	it.each([
		'ambion://room/Site',
		'ambion://room/site/message/0',
		'ambion://room/site/message/01',
		'ambion://room/site/message/1.5',
		'ambion://room/site/message/9007199254740993',
		'ambion://room/site/',
		'ambion://room/site?x=1',
		'ambion://room/site#top',
		'AMBION://room/site',
		'ambion://room/site/message/1/extra',
		'ambion://room/',
	])('refuses %s', (uri) => {
		expect(parseRoomUri(uri)).toBeUndefined();
	});

	it('refuses a bad name or a bad seq when it builds', () => {
		expect(() => roomUri('Site')).toThrow(AmbionError);
		expect(() => messageUri('site', 0)).toThrow(RangeError);
		expect(() => messageUri('site', 1.5)).toThrow(RangeError);
	});
});

describe('refs', () => {
	it.each([
		'https://x/y',
		's3://b/k',
		'file:///a',
		'mailto:a@b',
		'ambion://room/site',
		'ambion://room/site/message/12',
	])('accepts %s', (ref) => {
		expect(isRef(ref)).toBe(true);
	});

	it.each([
		'shared/report.md',
		'https://x/a b',
		'https://x/a\nb',
		'https://x/a\u0000b',
		`https://${'x'.repeat(REF_LIMITS.length)}`,
		'ambion:',
		'ambion://room/Site',
		'Ambion://room/site',
	])('refuses %j', (ref) => {
		expect(isRef(ref)).toBe(false);
	});

	it('refuses a list that breaks a rule and accepts an empty one', () => {
		expect(refsRefusal([])).toBeUndefined();
		expect(refsRefusal(['https://x/a', 'https://x/b'])).toBeUndefined();
		expect(refsRefusal('https://x/a')).toMatch(/array/);
		expect(refsRefusal([1])).toMatch(/refs\[0\]/);
		expect(refsRefusal(['https://x/a', 'https://x/a'])).toMatch(/refs\[1\]/);
		const many = Array.from({ length: REF_LIMITS.count + 1 }, (_, i) => `https://x/${i}`);
		expect(refsRefusal(many)).toMatch(/17 entries/);
	});
});

const person = defineHuman({ name: 'priya', identity: 'Project manager.' });
const product = scriptedAgent('product');

const answerRefs = ['https://x/a', 'ambion://room/other'];

const spoken = (messages: readonly Message[]) =>
	messages.find((message) => message.kind === 'said' && message.from === 'product');

describe.each(storages)('refs through the room on $name storage', (storage) => {
	it('stores refs on a said and on a summary, and keeps them across a restart', async () => {
		const opened = await storage.open();
		const name = roomName(`refs-room-${storage.name}`);
		let from = 0;
		const stream = scripted(
			byAgent({
				product: (_context, _agent, call) =>
					call === 1 ? callTool('say', { text: 'Answer.', refs: answerRefs }) : quiet(),
				assistant: (context) =>
					isClosing(context)
						? callTool('say', { text: 'Summary.', refs: [messageUri(name, from)] })
						: quiet(),
			}),
		);
		const room = stopAtEnd(
			await startRoom({
				name,
				goal: 'Cite what is said.',
				agents: [product, assistant],
				seats: { product: 'broadcast', assistant: 'none' },
				summary: assistant.name,
				runtime: createRuntime({ storage: opened.storage }),
				execution: piExecution({ sessions: 'memory', stream }),
			}),
		);
		const events = collect(room);
		const exchange = await (await room.visit(person)).send({ text: 'Question?' });
		from = exchange.from;
		expect(spoken(await exchange.waitForClose())).toMatchObject({ refs: answerRefs });
		const cited = [messageUri(name, exchange.from)];
		expect(await exchange.waitForSummary()).toMatchObject({ kind: 'summary', refs: cited });
		const notified = events.flatMap((event) =>
			event.type === 'message' &&
			(isSpoken(event.message) || isSummary(event.message)) &&
			event.message.refs !== undefined
				? [event.message.refs]
				: [],
		);
		expect(notified).toEqual([answerRefs, cited]);
		await room.stop();

		const runtime = createRuntime({ storage: opened.storage });
		const resumed = stopAtEnd(
			await resumeRoom(name, {
				agents: [product, assistant],
				runtime,
				execution: piExecution({ sessions: 'memory', stream }),
			}),
		);
		const read = await readExchange(name, exchange.from, { runtime });
		const whole = await readRoom(name, { runtime });
		expect(spoken(read?.messages ?? [])).toMatchObject({ refs: answerRefs });
		expect(spoken(whole.messages)).toMatchObject({ refs: answerRefs });
		const summary = whole.messages.find((message) => message.kind === 'summary');
		expect(summary).toMatchObject({ refs: cited });
		(summary?.refs as string[] | undefined)?.push('https://x/mutated');
		const again = await readRoom(name, { runtime });
		expect(again.messages.find((message) => message.kind === 'summary')?.refs).toEqual(cited);
		await resumed.stop();
		await opened.dispose();
	});
});
