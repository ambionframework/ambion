/**
 * Room URIs and refs: the pure rules, and the refs a said and a summary carry
 * through a room, a restart, and a read.
 */
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	AmbionError,
	commitUri,
	createRuntime,
	defineHuman,
	isSpoken,
	isSummary,
	type Message,
	messageUri,
	parseCommitUri,
	parseRoomUri,
	parseSnapshotUri,
	readExchange,
	readRoom,
	resumeRoom,
	roomUri,
	snapshotUri,
	startRoom,
} from '../src/index.ts';
import { isRef, REF_LIMITS, refsRefusal } from '../src/refs.ts';
import { assistant, collect, roomName, scriptedAgent } from './support/room.ts';
import { byAgent, callTool, isClosingContext, quiet, scripted } from './support/scripted.ts';
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

const DIGEST = 'a'.repeat(64);
const SNAPSHOT = `ambion://workspace/lab/snapshot/${DIGEST}`;

describe('snapshot URIs', () => {
	it.each([
		['/home/analyst/report.md', `${SNAPSHOT}/home/analyst/report.md`],
		['/shared/a b/r%.md', `${SNAPSHOT}/shared/a%20b/r%25.md`],
		['/é', `${SNAPSHOT}/%C3%A9`],
	])('round-trips %j', (path, uri) => {
		expect(snapshotUri('lab', DIGEST, path)).toBe(uri);
		expect(parseSnapshotUri(uri)).toEqual({ workspace: 'lab', digest: DIGEST, path });
	});

	it.each([
		`${SNAPSHOT}`,
		`${SNAPSHOT}/`,
		`${SNAPSHOT}/a//b`,
		`${SNAPSHOT}/a/../b`,
		`${SNAPSHOT}/./b`,
		`${SNAPSHOT}/a%2Fb`,
		`${SNAPSHOT}/a%00b`,
		`${SNAPSHOT}/a%0Ab`,
		`${SNAPSHOT}/a%1B%5B31mred`,
		`${SNAPSHOT}/a%7Fb`,
		`${SNAPSHOT}/a%zz`,
		`${SNAPSHOT}/a%2db`,
		`${SNAPSHOT}/a%20`.replace('%20', ' '),
		`ambion://workspace/Lab/snapshot/${DIGEST}/a`,
		`ambion://workspace/lab/snapshot/${'A'.repeat(64)}/a`,
		`ambion://workspace/lab/snapshot/${'a'.repeat(63)}/a`,
		`ambion://workspace/lab/file/${DIGEST}/a`,
	])('refuses %s', (uri) => {
		expect(parseSnapshotUri(uri)).toBeUndefined();
	});

	it.each([
		['Lab', DIGEST, '/a'],
		['lab', 'abc', '/a'],
		['lab', DIGEST, 'a'],
		['lab', DIGEST, '/a/'],
		['lab', DIGEST, '/a/../b'],
		['lab', DIGEST, '/a\nb'],
		['lab', DIGEST, '/a\u001b[2Jb'],
	])('refuses to build %s %s %s', (workspace, digest, path) => {
		expect(() => snapshotUri(workspace, digest, path)).toThrow(RangeError);
	});
});

const SHA = 'c'.repeat(40);
const REPO = 'ambion://workspace/lab/repo/analyst/site';

describe('commit URIs', () => {
	it.each([
		[undefined, `${REPO}/commit/${SHA}`],
		[{ branch: 'main' }, `${REPO}/branch/main/commit/${SHA}`],
		[{ branch: 'feature/pour' }, `${REPO}/branch/feature%2Fpour/commit/${SHA}`],
		[{ tag: 'v1.0' }, `${REPO}/tag/v1.0/commit/${SHA}`],
	])('round-trips a commit named by %j', (via, uri) => {
		expect(commitUri('lab', 'analyst/site', SHA, via)).toBe(uri);
		expect(parseCommitUri(uri)).toEqual({
			workspace: 'lab',
			repository: 'analyst/site',
			commit: SHA,
			...via,
		});
	});

	it('takes a SHA-256 hash of 64 digits', () => {
		const sha256 = 'd'.repeat(64);
		expect(parseCommitUri(`${REPO}/commit/${sha256}`)?.commit).toBe(sha256);
	});

	it.each([
		`${REPO}/commit/${'c'.repeat(7)}`,
		`${REPO}/commit/${'C'.repeat(40)}`,
		`${REPO}/commit/${'c'.repeat(41)}`,
		`${REPO}/branch/commit/${SHA}`,
		`${REPO}/branch/feature/pour/commit/${SHA}`,
		`${REPO}/branch/%2e%2e/commit/${SHA}`,
		`${REPO}/branch/ma%69n/commit/${SHA}`,
		`${REPO}/branch/a%zz/commit/${SHA}`,
		`${REPO}/branch/x%1B%5B2J/commit/${SHA}`,
		`${REPO}/tag/v%0A1/commit/${SHA}`,
		`${REPO}/head/main/commit/${SHA}`,
		`ambion://workspace/lab/repo/site/commit/${SHA}`,
		`ambion://workspace/lab/repo/analyst%2Fx/site/commit/${SHA}`,
		`ambion://workspace/Lab/repo/analyst/site/commit/${SHA}`,
	])('refuses %s', (uri) => {
		expect(parseCommitUri(uri)).toBeUndefined();
	});

	it.each([
		['Lab', 'analyst/site', SHA, undefined],
		['lab', 'site', SHA, undefined],
		['lab', 'a/b/c', SHA, undefined],
		['lab', 'analyst/..', SHA, undefined],
		['lab', 'analyst/site', 'abc1234', undefined],
		['lab', 'analyst/site', SHA, { branch: '' }],
		['lab', 'analyst/site', SHA, { tag: '..' }],
	])('refuses to build %s %s %s %j', (workspace, repository, commit, via) => {
		expect(() => commitUri(workspace, repository, commit, via)).toThrow(RangeError);
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
		`${SNAPSHOT}/home/analyst/report.md`,
		`${REPO}/tag/v1.0/commit/${SHA}`,
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
		`${SNAPSHOT}/a/../b`,
		'ambion://workspace/lab',
		`${REPO}/branch/main`,
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
					isClosingContext(context)
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
				summaryWriter: assistant.name,
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
