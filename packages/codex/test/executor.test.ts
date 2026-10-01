/**
 * The executor over a client that replays recorded events: the seat text
 * in the client config, exchange continuity, and the recipe that turns
 * native tools off.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Message } from '@ambionframework/ambion';
import type {
	CommitRequest,
	CommitResult,
	PassInput,
	VendorSession,
} from '@ambionframework/ambion/hosting';
import { describe, expect, it } from 'vitest';
import type { ActivationState } from '../../ambion/src/execution/activation.ts';
import { RESUMED_NOTE } from '../src/options.ts';
import { recorded } from './fixtures.ts';
import { open, sayingTurn, seat, viewOf } from './support.ts';

const ID = '01a0c21c-ffca-7082-9772-3bac91d64bc7';
const plain = recorded('plain-answer');

/** The first view of an activation, with the session the room recorded. */
function input(resume?: VendorSession): PassInput {
	const view = viewOf();
	return { kind: 'view', view: resume ? { ...view, spec: { ...view.spec, resume } } : view };
}

/** Run one pass of a session and read the session it reports. */
async function run(session: ActivationState, resume?: VendorSession) {
	const result = await session.pass(input(resume));
	session.close?.();
	return { result, session: session.session };
}

describe('exchange continuity', () => {
	it('records the thread id, resumes only the thread the view names, and keeps the seat text out of the prompt', async () => {
		const room = open([plain, plain, plain]);
		const first = await run(room.activate('a1'));
		expect(first.result).toEqual({ failed: false });
		expect(first.session).toEqual({ kind: 'codex', id: ID });
		await run(room.activate('a2'), first.session);
		await run(room.activate('a3'));
		expect(room.seen.opened).toEqual([
			{ resume: undefined },
			{ resume: ID },
			{ resume: undefined },
		]);
		expect(room.seen.prompts[0]).not.toContain(RESUMED_NOTE);
		expect(RESUMED_NOTE).toContain('`say`');
		expect(RESUMED_NOTE).toContain('reaches no one');
	});

	it.each([
		{
			what: 'resumes the thread the room recorded, after a restart',
			kind: 'codex',
			resume: 'saved',
		},
		{
			what: 'ignores a session that another harness recorded',
			kind: 'claude',
			resume: undefined,
		},
	])('$what', async ({ kind, resume }) => {
		const room = open([plain]);
		await run(room.activate(), { kind, id: 'saved' });
		expect(room.seen.opened).toEqual([{ resume }]);
		// The seat text stays in the instructions file, also for a thread that resumes.
		expect(room.seen.prompts[0]).not.toContain(RESUMED_NOTE);
	});

	it('starts a fresh thread when the resume fails before the thread starts', async () => {
		const room = open([new Error('Codex Exec exited with code 1: no session'), plain]);
		const session = room.activate();
		const result = await session.pass(input({ kind: 'codex', id: 'bogus' }));
		session.close?.();
		expect(result).toEqual({ failed: false });
		expect(room.seen.opened).toEqual([{ resume: 'bogus' }, { resume: undefined }]);
		expect(room.seen.prompts).toHaveLength(2);
		expect(room.seen.prompts[1]).toBe(room.seen.prompts[0]);
		expect(session.session).toEqual({ kind: 'codex', id: ID });
		expect(room.events.filter((event) => event.type === 'error')).toEqual([]);
	});

	it('reports a failure of a fresh thread and does not try again', async () => {
		const room = open([new Error('connection reset')]);
		const { result } = await run(room.activate());
		expect(result).toMatchObject({ failed: true, cause: 'transient', message: 'connection reset' });
		expect(room.seen.opened).toEqual([{ resume: undefined }]);
	});
});

/**
 * A room that keeps one message for each commit key, as the journal does. A
 * commit under a key the room holds gets the message it already holds.
 */
function keyedRoom() {
	const byKey = new Map<string, Message>();
	return (request: CommitRequest): CommitResult => {
		const held = byKey.get(request.key);
		if (held !== undefined) return { committed: held };
		if (request.intent.kind !== 'said') return { refused: 'unused' };
		const message: Message = {
			kind: 'said',
			seq: byKey.size + 2,
			key: request.key,
			activation: request.activation,
			at: new Date(0).toISOString(),
			from: 'gpt',
			text: request.intent.text,
		};
		byKey.set(request.key, message);
		return { committed: message };
	};
}

describe('room tools', () => {
	it('lands the say of each activation under its own key, though codex numbers the items of each turn again', async () => {
		const answer = keyedRoom();
		const room = open(
			[sayingTurn('The pour is Saturday.'), sayingTurn('The pour is Saturday.')],
			seat(),
			answer,
		);
		const first = await run(room.activate('message:1:gpt:1'));
		await run(room.activate('message:3:gpt:1'), first.session);
		const keys = room.commits.map((request) => request.key);
		expect(keys).toHaveLength(2);
		expect(new Set(keys).size).toBe(2);
		const calls = room.steps.flatMap((step) => (step.type === 'tool_call' ? [step.call] : []));
		expect(calls).toEqual(keys);
	});
});

describe('native tools', () => {
	it('runs a seat under the exclusive recipe, and removes the scratch on close', async () => {
		const room = open([plain]);
		const session = room.activate();
		const result = await session.pass(input());
		const config = room.seen.clients[0]?.config as {
			model_catalog_json: string;
			model_instructions_file: string;
		};
		const thread = room.seen.threads[0];
		expect(result).toEqual({ failed: false });
		expect(existsSync(config.model_catalog_json)).toBe(true);
		// The file holds the seat text, and the prompt holds the view alone.
		const text = readFileSync(config.model_instructions_file, 'utf8');
		expect(text.startsWith(RESUMED_NOTE)).toBe(true);
		expect(text).toContain('Answer once.');
		expect(room.seen.prompts[0]).not.toContain('Answer once.');
		expect(thread?.workingDirectory && readdirSync(thread.workingDirectory)).toEqual([]);
		expect(thread?.sandboxMode).toBe('read-only');
		session.close?.();
		expect(existsSync(config.model_catalog_json)).toBe(false);
		expect(existsSync(config.model_instructions_file)).toBe(false);
	});

	it('does not start a model that the catalog lacks, and fails as permanent', async () => {
		const room = open([plain], seat({ model: 'gpt-unknown' }));
		const { result } = await run(room.activate());
		expect(result).toMatchObject({ failed: true, cause: 'permanent' });
		expect(result.failed && result.message).toMatch(/gpt-unknown/);
		expect(room.seen.opened).toEqual([]);
		expect(room.events.some((event) => event.type === 'error')).toBe(true);
	});
});
