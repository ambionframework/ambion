/**
 * A process that dies in the middle of a pass leaves work in its session on
 * disk: a request, a tool call, or an input that nobody answered. The
 * activation that reopens the session ends that work before it submits. The
 * lost request and the lost tool call run again for no one, and the model
 * reads the record once.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineAgent, defineTool } from '@ambionframework/ambion';
import { quiet } from '@ambionframework/ambion/testing';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { pi } from '../src/index.ts';
import { diskSessions } from '../src/sessions.ts';
import { tempDir } from './support/temp.ts';
import { began, seatOn, TwoQuestions, texts } from './support/two-questions.ts';

const child = fileURLToPath(new URL('./support/crash-child.ts', import.meta.url));

describe('a session a process left in the middle of a pass', () => {
	it.each([
		['a request in flight', 'request'],
		['a tool call that runs', 'tool'],
		['a second request in flight, after a tool result', 'second'],
	])('ends the work of %s before the next activation submits', async (_name, mode) => {
		const dir = await tempDir('ambion-crash-');
		const dead = spawnSync(process.execPath, [child, dir, mode], { encoding: 'utf8' });
		expect(dead.signal).toBe('SIGKILL');
		expect(dead.stdout).not.toContain('survived');

		// A seat that counts what runs: the lost call and the lost request must not.
		let tools = 0;
		const book = defineTool({
			name: 'book',
			description: 'Book a day.',
			parameters: Type.Object({}),
			execute: () => {
				tools += 1;
				return 'booked';
			},
		});
		const definition = defineAgent({
			name: 'product',
			identity: 'Product.',
			executor: pi({ instructions: 'Work.', model: 'scripted/product', tools: [book] }),
		});
		let requests = 0;
		const { run, seen } = seatOn(
			new TwoQuestions(),
			diskSessions(dir),
			() => {
				requests += 1;
				return quiet();
			},
			definition,
		);
		const resumed = await run('message:2:product:1', { resume: began(1) });
		expect(resumed.result).toEqual({ failed: false });
		expect(resumed.session).toEqual(began(1));
		// One request: the one of this activation. No tool ran for the lost call.
		expect(requests).toBe(1);
		expect(tools).toBe(0);
		// The lost pass left the context: the model reads the whole view once, and nothing of the lost pass.
		const prompts = texts(seen.at(-1) as (typeof seen)[number]);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("The record of 'memory' so far:");
		expect(seen.at(-1)?.messages.map((message) => message.role)).toEqual(['user']);
	});
});
