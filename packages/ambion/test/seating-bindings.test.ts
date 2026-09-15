import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	defineTool,
	type SessionOpener,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { deferred, roomName } from './support/room.ts';
import { callTool, quiet, scripted, toolNames } from './support/scripted.ts';
import { faultyOpener, gatedOpener, memory, tappedOpener } from './support/storage.ts';

const agent = (name: string, tool: string, calls: string[]) =>
	defineAgent({
		name,
		identity: name,
		instructions: name,
		model: `scripted/${name}`,
		tools: [
			defineTool({
				name: tool,
				description: tool,
				parameters: Type.Object({}),
				execute: () => {
					calls.push(tool);
					return tool;
				},
			}),
		],
	});

const runTool = (tool: string) =>
	scripted((context, _agent, call) =>
		call === 1 && toolNames(context).includes(tool) ? callTool(tool, {}) : quiet(),
	);

const unreadableOpener = (sessions: SessionOpener) => {
	let unreadable = false;
	return {
		sessions: {
			open: async (id: string, parentId?: string) => {
				const session = await sessions.open(id, parentId);
				const find = session.findEntries.bind(session);
				session.findEntries = async (query) => {
					if (unreadable) throw new Error('the storage is unreadable');
					return find(query);
				};
				return session;
			},
		},
		fail: (value: boolean) => {
			unreadable = value;
		},
	};
};

describe('pending seating bindings', () => {
	it('refuses a competing definition submitted in the same turn', async () => {
		const opened = await memory.open();
		const chosen = agent('analyst', 'chosen', []);
		const other = agent('analyst', 'other', []);
		const session = startSession({
			name: roomName('same-turn-binding'),
			runtime: createRuntime({ sessions: opened.sessions }),
			streamFn: scripted(() => quiet()),
		});
		try {
			await session.messages();
			const seating = session.seat(chosen);
			await expect(session.seat(other)).rejects.toThrow(/already being seated/);
			await seating;
			expect(session.seats().find((seat) => seat.name === 'analyst')).toMatchObject({
				identity: 'analyst',
			});
		} finally {
			await stopSession(session);
			await opened.dispose();
		}
	});

	it('keeps the selected definition while its seating entry waits', async () => {
		const opened = await memory.open();
		const gate = deferred();
		const entered = deferred();
		let hold = true;
		const sessions = gatedOpener(opened.sessions, (type) => {
			if (!hold || type !== 'ambion/message') return undefined;
			entered.resolve();
			return gate.promise;
		});
		const calls: string[] = [];
		const chosen = agent('analyst', 'chosen', calls);
		const other = agent('analyst', 'other', calls);
		const session = startSession({
			name: roomName('gated-binding'),
			runtime: createRuntime({ sessions }),
			streamFn: runTool('chosen'),
		});
		try {
			await session.messages();
			const seating = session.seat(chosen);
			await entered.promise;
			await expect(session.seat(other)).rejects.toThrow(/already being seated/);
			hold = false;
			gate.resolve();
			await seating;
			await (
				await visitSession(session, defineHuman({ name: 'priya', identity: 'Priya' }))
			).deliver({ text: 'Go' });
			await session.settled();
			expect(calls).toEqual(['chosen']);
		} finally {
			hold = false;
			gate.resolve();
			await stopSession(session);
			await opened.dispose();
		}
	});

	it('promotes a seating binding when storage loses its confirmation', async () => {
		const opened = await memory.open();
		const faulty = faultyOpener(opened.sessions);
		const calls: string[] = [];
		const chosen = agent('analyst', 'chosen', calls);
		const session = startSession({
			name: roomName('lost-binding'),
			runtime: createRuntime({ sessions: faulty.sessions }),
			streamFn: runTool('chosen'),
		});
		try {
			await session.messages();
			faulty.fail('after', 'ambion/message');
			await expect(session.seat(chosen)).rejects.toThrow(/disk is full/);
			faulty.fail(false);
			await session.quiet();
			await (
				await visitSession(session, defineHuman({ name: 'priya', identity: 'Priya' }))
			).deliver({ text: 'Go' });
			await session.settled();
			expect(calls).toEqual(['chosen']);
		} finally {
			faulty.fail(false);
			await stopSession(session);
			await opened.dispose();
		}
	});

	it('keeps a confirmed binding through failed recovery reads', async () => {
		const opened = await memory.open();
		const unreadable = unreadableOpener(opened.sessions);
		let failAppend = true;
		const sessions = tappedOpener(unreadable.sessions, (_id, _n, phase, type) => {
			if (!failAppend || phase !== 'after' || type !== 'ambion/message') return;
			failAppend = false;
			unreadable.fail(true);
			throw new Error('the disk is full');
		});
		const calls: string[] = [];
		const chosen = agent('analyst', 'chosen', calls);
		const other = agent('analyst', 'other', calls);
		const session = startSession({
			name: roomName('unread-confirmed-binding'),
			runtime: createRuntime({ sessions }),
			streamFn: runTool('chosen'),
		});
		try {
			await session.messages();
			await expect(session.seat(chosen)).rejects.toThrow(/disk is full/);
			unreadable.fail(false);
			await expect(session.seat(other)).rejects.toThrow();
			await (
				await visitSession(session, defineHuman({ name: 'priya', identity: 'Priya' }))
			).deliver({ text: 'Go' });
			await session.settled();
			expect(calls).toEqual(['chosen']);
		} finally {
			unreadable.fail(false);
			await stopSession(session);
			await opened.dispose();
		}
	});

	it('releases an absent binding after a later successful recovery read', async () => {
		const opened = await memory.open();
		const unreadable = unreadableOpener(opened.sessions);
		let failAppend = true;
		const sessions = tappedOpener(unreadable.sessions, (_id, _n, phase, type) => {
			if (!failAppend || phase !== 'before' || type !== 'ambion/message') return;
			failAppend = false;
			unreadable.fail(true);
			throw new Error('the disk is full');
		});
		const original = agent('analyst', 'original', []);
		const replacement = agent('analyst', 'replacement', []);
		const session = startSession({
			name: roomName('unread-absent-binding'),
			runtime: createRuntime({ sessions }),
			streamFn: runTool('replacement'),
		});
		try {
			await session.messages();
			await expect(session.seat(original)).rejects.toThrow(/disk is full/);
			unreadable.fail(false);
			await session.seat(replacement);
			expect(session.seats().find((seat) => seat.name === 'analyst')).toMatchObject({
				identity: 'analyst',
			});
		} finally {
			unreadable.fail(false);
			await stopSession(session);
			await opened.dispose();
		}
	});
});
