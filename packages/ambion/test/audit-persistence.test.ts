import { type JournalOpener, type JournalStorage, memoryJournals } from '@ambionframework/journal';
import type { AuditSession as PiSession, SessionOpener } from '@ambionframework/pi-journal';
import { piSessions } from '@ambionframework/pi-journal';
import type { Agent, AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { Activation, type PiExecutorOptions, persistTurns } from '../src/execution/activation.ts';
import { stubModel } from '../src/execution/services.ts';
import { defineAgent, pi } from '../src/index.ts';
import type { ActivationView, RoomProtocol } from '../src/protocol.ts';
import { quiet, scripted } from '../src/testing.ts';
import type { RoomNotification } from '../src/types.ts';

const message: AgentMessage = { role: 'user', content: 'hello', timestamp: 1 };
const agent = { state: { messages: [message] } } as unknown as Agent;

const product = defineAgent({
	name: 'product',
	identity: 'The one product.',
	executor: pi({ instructions: 'answer', model: 'scripted/product' }),
});

const unusedRoom: RoomProtocol = {
	view: async () => ({ stale: 'unused' }),
	commit: async () => ({ stale: 'unused' }),
	lease: async () => ({ stale: 'unused' }),
};

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

function stubSession(): PiSession {
	return { appendEntry: async () => {} } as unknown as PiSession;
}

function activationFor(
	stream: StreamFn,
	openAudit: () => Promise<PiSession>,
	emit: (event: RoomNotification) => void,
): Activation {
	const options: PiExecutorOptions = {
		definition: product,
		model: stubModel,
		stream,
		transcripts: {
			open: async () => {
				throw new Error('unused');
			},
		} as SessionOpener,
		room: 'room',
		now: () => 0,
	};
	return new Activation({ id: 'activation', room: unusedRoom, emit }, options, openAudit);
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
	it('resolves the pass with no failure when it is cut while its audit write is blocked', async () => {
		let startPersist: () => void = () => {};
		let releasePersist: () => void = () => {};
		const persistStarted = new Promise<void>((resolve) => {
			startPersist = resolve;
		});
		const persist = new Promise<void>((resolve) => {
			releasePersist = resolve;
		});
		const openAudit = async (): Promise<PiSession> => {
			startPersist();
			await persist;
			return stubSession();
		};
		const activation = activationFor(
			scripted(() => quiet()),
			openAudit,
			() => {},
		);
		const running = activation.pass(activationView());
		await persistStarted;
		activation.abort();
		releasePersist();

		expect(await running).toEqual({ failed: false });
		// A cancelled session earns no further room round trip on its behalf:
		// the driver's freshness check reads this before it renews anything.
		expect(activation.cancelled).toBe(true);
		expect(activation.shouldRefresh(Number.MAX_SAFE_INTEGER)).toBe(false);
	});

	it('does not turn an audit notification failure into an execution failure', async () => {
		const openAudit = async (): Promise<PiSession> => {
			throw new Error('audit unavailable');
		};
		const activation = activationFor(
			scripted(() => quiet()),
			openAudit,
			(event) => {
				if (event.type === 'audit_error') throw new Error('notification unavailable');
			},
		);

		expect(await activation.pass(activationView())).toEqual({ failed: false });
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
		const openAudit = async (): Promise<PiSession> => {
			startPersist();
			await persist;
			return stubSession();
		};
		const events: string[] = [];
		const stream = scripted(() =>
			fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'provider' }),
		);
		const activation = activationFor(stream, openAudit, (event) => {
			if (event.type === 'error') events.push(event.error.message);
		});
		const running = activation.pass(activationView());
		await persistStarted;
		// The provider failure is recorded before the blocked audit write can be cut.
		expect(events).toEqual(['provider']);
		activation.abort();
		releasePersist();

		expect(await running).toEqual({ failed: true, cause: 'transient' });
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
