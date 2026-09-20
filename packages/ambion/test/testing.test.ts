/** The `/testing` entry: the stream, the wait, and the clock, proved through a room. */
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { stubModel } from '../src/execution/services.ts';
import { createRuntime, defineAgent, pi, type Room, startRoom } from '../src/index.ts';
import {
	byAgent,
	fakeClock,
	isClosing,
	quiet,
	type Script,
	scripted,
	settled,
	speak,
} from '../src/testing.ts';
import { andrei, collect, roomName } from './support/room.ts';

const agent = (name: string, model: string) =>
	defineAgent({
		name,
		identity: `The ${name} seat.`,
		executor: pi({ instructions: 'answer what is asked', model }),
	});

const started: Room[] = [];
afterEach(async () => {
	for (const room of started.splice(0)) await room.stop();
});

const open = async (options: Parameters<typeof startRoom>[0]) => {
	const room = await startRoom(options);
	started.push(room);
	return room;
};

describe('scripted', () => {
	it('routes on the seat and counts calls per seat', async () => {
		const seen: string[] = [];
		const record = (seat: string) => (_context: unknown, name: string, call: number) => {
			seen.push(`${seat}:${name}:${call}`);
			return quiet();
		};
		const room = await open({
			name: roomName('testing-route'),
			agents: [agent('a', 'anthropic/claude-x'), agent('b', 'anthropic/claude-x')],
			runtime: createRuntime(),
			stream: scripted(byAgent({ a: record('a'), b: record('b') })),
		});
		await (await room.visit(andrei)).send({ text: 'Hello?' });
		await settled(room);
		expect(seen).toContain('a:a:1');
		expect(seen).toContain('b:b:1');
		expect(seen.every((line) => line.split(':')[0] === line.split(':')[1])).toBe(true);
	});

	it('turns a script that throws into a transient error and writes no message', async () => {
		let calls = 0;
		const clock = fakeClock();
		const room = await open({
			name: roomName('testing-throws'),
			agents: [agent('a', 'scripted/a')],
			runtime: createRuntime({ clock, limits: { activation: { attempts: 1, backoff: () => 0 } } }),
			stream: scripted(() => {
				calls += 1;
				throw new Error('script failed');
			}),
		});
		const events = collect(room);
		await (await room.visit(andrei)).send({ text: 'Hello?' });
		await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true));
		const failure = events.find((event) => event.type === 'error');
		expect(failure).toMatchObject({ agent: 'a', cause: 'transient' });
		expect(calls).toBeGreaterThan(0);
		const { messages } = await room.read();
		expect(messages.filter((message) => message.kind === 'said' && message.from === 'a')).toEqual(
			[],
		);
	});

	it('answers an already aborted signal with an aborted message', async () => {
		const stream = scripted(() => speak('never'));
		const controller = new AbortController();
		controller.abort();
		const model = await stubModel('anthropic/x', 'product');
		const result = await (
			await stream(model, { messages: [] }, { signal: controller.signal })
		).result();
		expect(result.stopReason).toBe('aborted');
	});
});

describe('stubModel', () => {
	it('names the seat and needs no cast', async () => {
		const model = await stubModel('anthropic/x', 'product');
		expect(model.name).toBe('product');
		expect(model.id).toBe('anthropic/x');
		expectTypeOf(model.api).toBeString();
	});
});

/** A room with one product that answers and one writer that summarises. */
const summarised = (name: string, script: Script) =>
	open({
		name: roomName(name),
		agents: [agent('product', 'scripted/product'), agent('writer', 'scripted/writer')],
		summary: 'writer',
		seats: { product: 'broadcast', writer: 'none' },
		runtime: createRuntime(),
		stream: scripted(script),
	});

describe('isClosing', () => {
	it('is false for an ordinary activation and true for the summary activation', async () => {
		const flags: boolean[] = [];
		const room = await summarised(
			'testing-closing',
			byAgent({
				product: (context, _seat, call) => {
					flags.push(isClosing(context));
					return call === 1 ? speak('an answer') : quiet();
				},
				writer: (context, _seat, call) => {
					flags.push(isClosing(context));
					return call === 1 ? speak('the summary') : quiet();
				},
			}),
		);
		await (await room.visit(andrei)).send({ text: 'Question?' });
		await settled(room);
		expect(flags.filter((flag) => flag)).toHaveLength(1);
		expect(flags.at(-1)).toBe(true);
		expect(flags.slice(0, -1).every((flag) => !flag)).toBe(true);
	});
});

describe('settled', () => {
	it('resolves after the exchange closes and the summary lands, through the read and subscribe of a room alone', async () => {
		const room = await summarised(
			'testing-settled',
			byAgent({
				product: (_context, _seat, call) => (call === 1 ? speak('an answer') : quiet()),
				writer: (_context, _seat, call) => (call === 1 ? speak('the summary') : quiet()),
			}),
		);
		const reads = vi.fn(room.read.bind(room));
		await (await room.visit(andrei)).send({ text: 'Question?' });
		const read = await settled({
			name: room.name,
			read: reads,
			subscribe: room.subscribe.bind(room),
		});
		expect(read.exchange).toBeUndefined();
		expect(read.participants.every((p) => p.kind !== 'agent' || p.status === 'idle')).toBe(true);
		expect(read.exchanges[0]).toMatchObject({ summary: { status: 'published' } });
		expect(reads).toHaveBeenCalled();
	});

	it('rejects with the seat named while a backoff runs, and resolves after the clock moves', async () => {
		const clock = fakeClock();
		let failed = false;
		const room = await open({
			name: roomName('testing-backoff'),
			agents: [agent('a', 'scripted/a')],
			runtime: createRuntime({
				clock,
				limits: { activation: { attempts: 2, backoff: () => 30_000 } },
			}),
			stream: scripted(() => {
				if (failed) return quiet();
				failed = true;
				throw new Error('once');
			}),
		});
		await (await room.visit(andrei)).send({ text: 'Question?' });
		await expect(settled(room, { timeout: 50 })).rejects.toThrow(
			/did not settle within 50 ms: active .*; exchange \d+\./,
		);
		await clock.advance(30_000);
		await expect(settled(room)).resolves.toMatchObject({ exchange: undefined });
	});
});

describe('fakeClock', () => {
	it('fires alarms in time order inside one advance, chained ones included', async () => {
		const clock = fakeClock(1_000);
		const fired: string[] = [];
		clock.alarm(1_300, () => fired.push('c'));
		clock.alarm(1_100, () => {
			fired.push('a');
			clock.alarm(clock.now(), () => fired.push('a-again'));
		});
		clock.alarm(1_200, () => fired.push('b'));
		await clock.advance(500);
		expect(fired).toEqual(['a', 'a-again', 'b', 'c']);
		expect(clock.now()).toBe(1_500);
	});
});

it('builds an assistant message with the faux helper the entry re-uses', () => {
	expect(quiet().stopReason).toBe('stop');
	expect(speak('hi').stopReason).toBe('toolUse');
	expect(fauxAssistantMessage('x').role).toBe('assistant');
});
