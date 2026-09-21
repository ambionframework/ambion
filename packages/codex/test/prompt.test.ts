/** The first prompt of an activation carries the harness note. */
import type { PassInput } from '@ambionframework/ambion/hosting';
import { describe, expect, it } from 'vitest';
import { HARNESS_NOTE } from '../src/executor.ts';
import { recorded } from './fixtures.ts';
import { open, viewOf } from './support.ts';

const input = (): PassInput => ({ kind: 'view', view: viewOf() }) as PassInput;

describe('the first prompt', () => {
	it('starts with the harness note, and then the mechanism', async () => {
		const room = open([recorded('plain-answer')]);
		const session = room.activate();
		await session.pass(input());
		session.close?.();
		expect(room.seen.prompts).toHaveLength(1);
		expect(room.seen.prompts[0]?.startsWith(HARNESS_NOTE)).toBe(true);
		expect(room.seen.prompts[0]?.length).toBeGreaterThan(HARNESS_NOTE.length);
	});

	it('names say as the only channel to the room', () => {
		expect(HARNESS_NOTE).toContain('`say`');
		expect(HARNESS_NOTE).toContain('reaches no one');
	});
});
