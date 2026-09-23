/**
 * The executor over a client that replays recorded events: the first
 * prompt, the memory modes, and the recipe that turns native tools off.
 */
import { existsSync, readdirSync } from 'node:fs';
import type { ExecutorSession, HarnessSession, PassInput } from '@ambionframework/ambion/hosting';
import { describe, expect, it } from 'vitest';
import { HARNESS_NOTE } from '../src/executor.ts';
import { recorded } from './fixtures.ts';
import { open, seat, viewOf } from './support.ts';

const ID = '01a0c21c-ffca-7082-9772-3bac91d64bc7';
const plain = recorded('plain-answer');

/** The first view of an activation, with the session the room recorded. */
function input(resume?: HarnessSession): PassInput {
	const view = viewOf();
	return { kind: 'view', view: resume ? { ...view, spec: { ...view.spec, resume } } : view };
}

/** Run one pass of a session and read the session it reports. */
async function run(session: ExecutorSession, resume?: HarnessSession) {
	const result = await session.pass(input(resume));
	session.close?.();
	return { result, session: session.session };
}

describe('memory activation', () => {
	it('opens a fresh thread for each activation, records no session, and starts the first prompt with the harness note', async () => {
		const room = open([plain, plain]);
		const first = await run(room.activate('a1'));
		const second = await run(room.activate('a2'));
		expect(first.result).toEqual({ failed: false });
		expect(first.session).toBeUndefined();
		expect(second.session).toBeUndefined();
		expect(room.seen.opened).toEqual([{ resume: undefined }, { resume: undefined }]);
		expect(room.seen.prompts).toHaveLength(2);
		expect(room.seen.prompts[0]?.startsWith(HARNESS_NOTE)).toBe(true);
		expect(room.seen.prompts[0]?.length).toBeGreaterThan(HARNESS_NOTE.length);
		expect(HARNESS_NOTE).toContain('`say`');
		expect(HARNESS_NOTE).toContain('reaches no one');
	});
});

describe('memory seat', () => {
	const definition = seat({ memory: 'seat' });

	it('records the thread id of the first activation, and resumes that thread in the next', async () => {
		const room = open([plain, plain], definition);
		expect((await run(room.activate('a1'))).session).toEqual({ harness: 'codex', id: ID });
		await run(room.activate('a2'));
		expect(room.seen.opened).toEqual([{ resume: undefined }, { resume: ID }]);
	});

	it.each([
		{
			what: 'resumes the thread the room recorded, after a restart',
			harness: 'codex',
			resume: 'saved',
		},
		{
			what: 'ignores a session that another harness recorded',
			harness: 'claude',
			resume: undefined,
		},
	])('$what', async ({ harness, resume }) => {
		const room = open([plain], definition);
		await run(room.activate(), { harness, id: 'saved' });
		expect(room.seen.opened).toEqual([{ resume }]);
	});

	it('starts a fresh thread when the resume fails before the thread starts', async () => {
		const room = open([new Error('Codex Exec exited with code 1: no session'), plain], definition);
		const session = room.activate();
		const result = await session.pass(input({ harness: 'codex', id: 'bogus' }));
		session.close?.();
		expect(result).toEqual({ failed: false });
		expect(room.seen.opened).toEqual([{ resume: 'bogus' }, { resume: undefined }]);
		expect(room.seen.prompts).toHaveLength(2);
		expect(room.seen.prompts[1]).toBe(room.seen.prompts[0]);
		expect(session.session).toEqual({ harness: 'codex', id: ID });
		expect(room.events.filter((event) => event.type === 'error')).toEqual([]);
	});

	it('reports a failure of a fresh thread and does not try again', async () => {
		const room = open([new Error('connection reset')], definition);
		const { result } = await run(room.activate());
		expect(result).toMatchObject({ failed: true, cause: 'transient', message: 'connection reset' });
		expect(room.seen.opened).toEqual([{ resume: undefined }]);
	});
});

describe('native tools', () => {
	it('runs a seat under the exclusive recipe by default, and removes the scratch on close', async () => {
		const room = open([plain]);
		const session = room.activate();
		const result = await session.pass(input());
		const config = room.seen.clients[0]?.config as { model_catalog_json: string };
		const thread = room.seen.threads[0];
		expect(result).toEqual({ failed: false });
		expect(existsSync(config.model_catalog_json)).toBe(true);
		expect(thread?.workingDirectory && readdirSync(thread.workingDirectory)).toEqual([]);
		expect(thread?.sandboxMode).toBe('read-only');
		session.close?.();
		expect(existsSync(config.model_catalog_json)).toBe(false);
	});

	it('leaves the client config alone with nativeTools codex', async () => {
		const room = open([plain], seat({ nativeTools: 'codex', sandboxMode: 'workspace-write' }));
		await run(room.activate());
		expect(Object.keys(room.seen.clients[0]?.config ?? {})).toEqual(['mcp_servers']);
		expect(room.seen.threads[0]?.sandboxMode).toBe('workspace-write');
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
