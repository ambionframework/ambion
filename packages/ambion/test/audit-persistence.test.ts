import { type JournalOpener, type JournalStorage, memoryJournals } from '@ambionframework/journal';
import { piSessions } from '@ambionframework/journal/pi';
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { Activation, type ActivationHost, persistTurns } from '../src/seat/activation.ts';
import type { ActivationView } from '../src/wire.ts';

const message: AgentMessage = { role: 'user', content: 'hello', timestamp: 1 };
const agent = { state: { messages: [message] } } as unknown as Agent;

function activationView(): ActivationView {
	return {
		spec: {
			id: 'activation',
			seat: 'product',
			attempt: 1,
			purpose: { kind: 'respond', message: 0 },
		},
		through: 0,
		context: { name: 'room', now: 0, participants: [], messages: [], reserve: [] },
	};
}

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

function intercepted(
	base: JournalOpener,
	hook: (name: string, storage: JournalStorage) => JournalStorage,
): JournalOpener {
	return {
		async open(name) {
			const storage = await base.open(name);
			return hook(name, storage);
		},
	};
}

describe('audit persistence', () => {
	it('keeps a successful activation released when cut during a blocked audit', async () => {
		let startPersist: () => void = () => {};
		let releasePersist: () => void = () => {};
		const persistStarted = new Promise<void>((resolve) => {
			startPersist = resolve;
		});
		const persist = new Promise<void>((resolve) => {
			releasePersist = resolve;
		});
		let renewals = 0;
		const host: ActivationHost = {
			view: async () => ({ view: activationView() }),
			renew: async () => {
				renewals += 1;
				return { stale: 'unused' };
			},
			build: async () => ({ agent: fakeAgent([{ stopReason: 'stop' }]), context: '' }),
			persist: async () => {
				startPersist();
				await persist;
			},
			emit: () => {},
			now: () => 0,
		};
		const activation = new Activation('activation', 'product', host);
		const running = activation.run();
		await persistStarted;
		activation.abort();
		releasePersist();
		await running;

		expect(activation.failed).toBe(false);
		expect(renewals).toBe(0);
	});

	it('does not turn an audit notification failure into an execution failure', async () => {
		const host: ActivationHost = {
			view: async () => ({ view: activationView() }),
			renew: async () => ({ stale: 'unused' }),
			build: async () => ({ agent: fakeAgent([{ stopReason: 'stop' }]), context: '' }),
			persist: async () => {
				throw new Error('audit unavailable');
			},
			emit: (event) => {
				if (event.type === 'audit_error') throw new Error('notification unavailable');
			},
			now: () => 0,
		};
		const activation = new Activation('activation', 'product', host);

		await activation.run();

		expect(activation.failed).toBe(false);
	});

	it('records provider failure before a blocked audit can be cut', async () => {
		let startPersist: () => void = () => {};
		let releasePersist: () => void = () => {};
		const persistStarted = new Promise<void>((resolve) => {
			startPersist = resolve;
		});
		const persist = new Promise<void>((resolve) => {
			releasePersist = resolve;
		});
		const events: string[] = [];
		const host: ActivationHost = {
			view: async () => ({ view: activationView() }),
			renew: async () => ({ stale: 'unused' }),
			build: async () => ({
				agent: fakeAgent([{ stopReason: 'error', errorMessage: 'provider' }]),
				context: '',
			}),
			persist: async () => {
				startPersist();
				await persist;
			},
			emit: (event) => {
				if (event.type === 'error') events.push(event.error.message);
			},
			now: () => 0,
		};
		const activation = new Activation('activation', 'product', host);
		const running = activation.run();
		await persistStarted;
		expect(activation.failed).toBe(true);
		activation.abort();
		releasePersist();
		await running;

		expect(events).toEqual(['provider']);
	});

	it('recovers an uncertain message append with the original snapshot and entry identities', async () => {
		const base = memoryJournals();
		const input: AgentMessage = { role: 'user', content: 'original', timestamp: 1 };
		let writes = 0;
		let opens = 0;
		let failRead = false;
		const journals = intercepted(base, (_name, storage) => ({
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
		}));
		const sessions = piSessions(journals);
		const open = () => {
			opens += 1;
			return sessions.open('stable');
		};

		await persistTurns(open, fakeAgent([input]), '2026-01-01T00:00:00.000Z');

		const entries = await (
			await piSessions(base).open('stable')
		).findEntries({ order: 'oldestFirst' });
		expect(opens).toBe(2);
		expect(writes).toBe(3);
		expect(entries.map((entry) => entry.type)).toEqual(['custom', 'message']);
		expect(entries[1]).toMatchObject({ message: { content: 'original' } });
	});

	it('replays confirmed entries and retries a later write without duplicates', async () => {
		const base = memoryJournals();
		let entryWrites = 0;
		const journals = intercepted(base, (_name, storage) => ({
			read: storage.read.bind(storage),
			async append(entry, expected) {
				if (
					typeof entry === 'object' &&
					entry !== null &&
					'kind' in entry &&
					entry.kind === 'entry'
				) {
					entryWrites += 1;
					if (entryWrites === 3) throw new Error('second message rejected');
				}
				return storage.append(entry, expected);
			},
		}));
		const sessions = piSessions(journals);
		const twoMessages = {
			state: { messages: [message, { role: 'assistant', content: 'done', timestamp: 2 }] },
		} as unknown as Agent;

		await persistTurns(() => sessions.open('later-write'), twoMessages, '2026-01-01T00:00:00.000Z');

		const entries = await (
			await piSessions(base).open('later-write')
		).findEntries({ order: 'oldestFirst' });
		expect(entries.map((entry) => entry.type)).toEqual(['custom', 'message', 'message']);
		expect(entryWrites).toBe(4);
	});

	it('reopens after an opener failure within the audit bound', async () => {
		const base = memoryJournals();
		let opens = 0;
		const journals = intercepted(base, (name, storage) => {
			if (name.startsWith('["ambion/pi-session",')) {
				opens += 1;
				if (opens === 1) throw new Error('open failed');
			}
			return storage;
		});
		const sessions = piSessions(journals);

		await persistTurns(() => sessions.open('reopen'), agent, '2026-01-01T00:00:00.000Z');

		expect(opens).toBe(2);
		expect(
			(await (await piSessions(base).open('reopen')).findEntries({ order: 'oldestFirst' })).map(
				(entry) => entry.type,
			),
		).toEqual(['custom', 'message']);
	});

	it('stops after two audit attempts', async () => {
		const base = memoryJournals();
		let opens = 0;
		const journals = intercepted(base, (name, storage) => {
			if (name.startsWith('["ambion/pi-session",')) {
				opens += 1;
				return {
					read: storage.read.bind(storage),
					async append() {
						throw new Error('audit unavailable');
					},
				};
			}
			return storage;
		});
		const sessions = piSessions(journals);

		await expect(
			persistTurns(() => sessions.open('bounded'), agent, '2026-01-01T00:00:00.000Z'),
		).rejects.toThrow('audit unavailable');
		expect(opens).toBe(2);
	});
});
