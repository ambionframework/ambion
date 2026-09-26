/**
 * The environment helpers a bash backend builds on, where the conformance
 * suite does not reach them: the members `HomeEnv` derives from the home, an
 * output view with no limits, a line reader, and a command that throws under `withDeadline`.
 */
import { BACKGROUND_CONTEXT, err, FileError, ok, type Result } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { boundedView, HomeEnv, withDeadline } from '../src/execution-env.ts';

const ctx = BACKGROUND_CONTEXT;

/** A `HomeEnv` over a fixed map of files. */
class FixedEnv extends HomeEnv {
	constructor(private readonly files: Record<string, string>) {
		super('/home/ada');
	}

	async readTextFile(path: string): Promise<Result<string, FileError>> {
		const resolved = this.resolve(path);
		const text = this.files[resolved];
		return text === undefined ? err(new FileError('not_found', 'no file', resolved)) : ok(text);
	}
}

describe('HomeEnv', () => {
	const env = new FixedEnv({ '/home/ada/a.txt': 'one\ntwo\nthree' });

	it('resolves and joins paths from the home, and reads lines up to a limit', async () => {
		expect(env.cwd).toBe('/home/ada');
		expect(await env.absolutePath('~/sub/../b')).toEqual({ ok: true, value: '/home/ada/b' });
		expect(await env.joinPath(['/tmp', 'x', '../y'])).toEqual({ ok: true, value: '/tmp/y' });
		expect(await env.readTextLines('a.txt', { maxLines: 2 }, ctx)).toEqual({
			ok: true,
			value: ['one', 'two'],
		});
		expect(await env.readTextLines('a.txt', undefined, ctx)).toEqual({
			ok: true,
			value: ['one', 'two', 'three'],
		});
		const missing = await env.readTextLines('b.txt', undefined, ctx);
		expect(!missing.ok && missing.error.code).toBe('not_found');
	});

	it.each([
		[
			'one\ntwo',
			[
				{ text: 'one', terminated: true },
				{ text: 'two', terminated: false },
			],
		],
		['one\n', [{ text: 'one', terminated: true }]],
		['', []],
	])('opens %j for line reading, and marks a torn final line', async (text, expected) => {
		const opened = await new FixedEnv({ '/home/ada/c.txt': text }).openTextLineReader('c.txt', ctx);
		if (!opened.ok) throw opened.error;
		const lines = [];
		for (let line = await opened.value.readLine(ctx); line.ok && line.value;) {
			lines.push(line.value);
			line = await opened.value.readLine(ctx);
		}
		await opened.value.close(ctx);
		expect(lines).toEqual(expected);
		const missing = await env.openTextLineReader('b.txt', ctx);
		expect(!missing.ok && missing.error.code).toBe('not_found');
	});
});

it('leaves the output whole when the caller names no limits', () => {
	expect(boundedView('a\nb\n', undefined)).toMatchObject({
		text: 'a\nb\n',
		truncation: { truncated: false },
	});
});

it.each([
	['an error', new Error('the channel broke'), 'the channel broke'],
	['a value that is no error', 'a bare string', 'a bare string'],
])('turns %s that a command throws into an unknown error', async (_name, thrown, message) => {
	const result = await withDeadline(undefined, 1, async () => {
		throw thrown;
	});
	expect(!result.ok && [result.error.code, result.error.message]).toEqual(['unknown', message]);
});
