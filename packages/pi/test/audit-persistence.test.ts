/**
 * The audit of a Pi activation: a blocked or failed audit write never turns
 * into an execution failure, and a retried write lands each entry once.
 */
import { memoryJournals } from '@ambionframework/journal';
import type { AuditSession } from '@ambionframework/pi-journal';
import { piSessions } from '@ambionframework/pi-journal';
import type { Agent } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { deferred } from '../../ambion/test/support/room.ts';
import { quiet, scripted } from '../../ambion/test/support/scripted.ts';
import { isEntryWrite, wrapped } from '../../pi-journal/test/support/journals.ts';
import { persistTurns } from '../src/audit.ts';
import { activationFor, viewFor } from './support/activation.ts';
import { worker } from './support/runner.ts';

const at = '2026-01-01T00:00:00.000Z';
const view = viewFor({ kind: 'respond', message: 0 });
const isSession = (name: string) => name.startsWith('["ambion/pi-session",');

/** An audit open that blocks until the test releases it. */
function blockedAudit() {
	const started = deferred();
	const released = deferred();
	const open = async (): Promise<AuditSession> => {
		started.resolve();
		await released.promise;
		return { appendEntry: async () => {} } as unknown as AuditSession;
	};
	return { started: started.promise, release: released.resolve, open };
}

/** A Pi agent that holds `messages` and does nothing else. */
function fakeAgent(messages: readonly object[]): Agent {
	return {
		state: { messages },
		subscribe: () => {},
		prompt: async () => {},
		abort: () => {},
		hasQueuedMessages: () => false,
		clearAllQueues: () => {},
	} as unknown as Agent;
}

/** The entry types of one stored session, oldest first. */
async function storedTypes(journals: ReturnType<typeof memoryJournals>, id: string) {
	const session = await piSessions(journals).open(id);
	return (await session.findEntries({ order: 'oldestFirst' })).map((entry) => entry.type);
}

const hello = { role: 'user', content: 'hello', timestamp: 1 };

describe('audit persistence', () => {
	it('resolves the pass with no failure when it is cut while its audit write is blocked', async () => {
		const audit = blockedAudit();
		const activation = activationFor('activation', worker, {
			stream: scripted(() => quiet()),
			openAudit: audit.open,
		});
		const running = activation.pass({ kind: 'view', view });
		await audit.started;
		activation.abort();
		audit.release();

		expect(await running).toEqual({ failed: false });
		// A cancelled session earns no further room round trip on its behalf:
		// the driver's freshness check reads this before it renews anything.
		expect(activation.cancelled).toBe(true);
		expect(activation.shouldRefresh(Number.MAX_SAFE_INTEGER)).toBe(false);
	});

	it('does not turn an audit notification failure into an execution failure', async () => {
		const activation = activationFor('activation', worker, {
			stream: scripted(() => quiet()),
			openAudit: async () => {
				throw new Error('audit unavailable');
			},
			emit: (event) => {
				if (event.type === 'audit_error') throw new Error('notification unavailable');
			},
		});
		expect(await activation.pass({ kind: 'view', view })).toEqual({ failed: false });
	});

	it('records provider failure before a blocked audit can be cut', async () => {
		const audit = blockedAudit();
		const events: string[] = [];
		const activation = activationFor('activation', worker, {
			stream: scripted(() =>
				fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider' }),
			),
			openAudit: audit.open,
			emit: (event) => {
				if (event.type === 'error') events.push(event.error.message);
			},
		});
		const running = activation.pass({ kind: 'view', view });
		await audit.started;
		// The provider failure is recorded before the blocked audit write can be cut.
		expect(events).toEqual(['provider']);
		activation.abort();
		audit.release();

		expect(await running).toMatchObject({ failed: true, cause: 'transient' });
		expect(events).toEqual(['provider']);
	});

	it('recovers an uncertain message append with the original snapshot and entry identities', async () => {
		const base = memoryJournals();
		const input = { role: 'user', content: 'original', timestamp: 1 };
		let writes = 0;
		let opens = 0;
		let failRead = false;
		const sessions = piSessions(
			wrapped(base, (storage) => ({
				async read(after) {
					if (failRead) {
						failRead = false;
						throw new Error('recovery read failed');
					}
					return storage.read(after);
				},
				async append(entry, expected) {
					const landed = await storage.append(entry, expected);
					if (landed !== undefined) writes += 1;
					// Metadata, activation marker, then the first message have landed.
					if (writes === 3 && landed !== undefined) {
						input.content = 'changed after capture';
						failRead = true;
						throw new Error('confirmation lost');
					}
					return landed;
				},
			})),
		);
		const open = () => {
			opens += 1;
			return sessions.open('stable');
		};

		await persistTurns(open, fakeAgent([input]), at);

		const entries = await (
			await piSessions(base).open('stable')
		).findEntries({
			order: 'oldestFirst',
		});
		expect(opens).toBe(2);
		expect(writes).toBe(3);
		expect(entries.map((entry) => entry.type)).toEqual(['custom', 'message']);
		expect(entries[1]).toMatchObject({ message: { content: 'original' } });
	});

	it('replays confirmed entries and retries a later write without duplicates', async () => {
		const base = memoryJournals();
		let entryWrites = 0;
		const sessions = piSessions(
			wrapped(base, (storage) => ({
				async append(entry, expected) {
					if (isEntryWrite(entry)) {
						entryWrites += 1;
						if (entryWrites === 3) throw new Error('second message rejected');
					}
					return storage.append(entry, expected);
				},
			})),
		);
		const done = { role: 'assistant', content: 'done', timestamp: 2 };

		await persistTurns(() => sessions.open('later-write'), fakeAgent([hello, done]), at);

		expect(await storedTypes(base, 'later-write')).toEqual(['custom', 'message', 'message']);
		expect(entryWrites).toBe(4);
	});

	it('reopens after an opener failure within the audit bound', async () => {
		const base = memoryJournals();
		let opens = 0;
		const sessions = piSessions(
			wrapped(base, (_storage, name) => {
				if (isSession(name)) opens += 1;
				if (isSession(name) && opens === 1) throw new Error('open failed');
				return {};
			}),
		);

		await persistTurns(() => sessions.open('reopen'), fakeAgent([hello]), at);

		expect(opens).toBe(2);
		expect(await storedTypes(base, 'reopen')).toEqual(['custom', 'message']);
	});

	it('stops after two audit attempts', async () => {
		let opens = 0;
		const sessions = piSessions(
			wrapped(memoryJournals(), (_storage, name) => {
				if (!isSession(name)) return {};
				opens += 1;
				return {
					async append() {
						throw new Error('audit unavailable');
					},
				};
			}),
		);

		await expect(
			persistTurns(() => sessions.open('bounded'), fakeAgent([hello]), at),
		).rejects.toThrow('audit unavailable');
		expect(opens).toBe(2);
	});
});
