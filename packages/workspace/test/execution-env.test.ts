/**
 * The environment helpers a bash backend builds on, where the conformance
 * suite does not reach them: the members `HomeEnv` derives from the home, an
 * output view with no limits, and a command that throws under `withDeadline`.
 */
import { describe, expect, it } from 'vitest';
import {
	boundedView,
	type FileExpect,
	type FileOperations,
	HomeEnv,
	withDeadline,
} from '../src/execution-env.ts';
import { FileError } from '../src/port.ts';

/** A `HomeEnv` over a fixed map of files. It records each operation and each expect hint. */
class FixedEnv extends HomeEnv {
	readonly calls: string[] = [];
	readonly hints: string[] = [];

	constructor(private readonly contents: Record<string, string>) {
		super('/home/ada');
	}

	protected readonly files: FileOperations = {
		readText: async (path) => {
			this.calls.push(`readText ${path}`);
			const text = this.contents[path];
			if (text === undefined) throw new Error(`no file ${path}`);
			return text;
		},
		readBinary: async (path) => new TextEncoder().encode(this.contents[path]),
		write: async () => {},
		append: async () => {},
		rename: async () => {},
		info: async () => {
			throw new Error('no info');
		},
		list: async () => {
			throw new Error('no list');
		},
		canonical: async (path) => path,
		exists: async (path) => this.contents[path] !== undefined,
		makeDir: async () => {},
		remove: async () => {},
	};

	/** The classifier is asynchronous, as the workstation's is. */
	protected async classify(error: unknown, path: string, expect: FileExpect): Promise<FileError> {
		this.hints.push(expect);
		return new FileError('not_found', String(error), path);
	}
}

describe('HomeEnv', () => {
	it('resolves a path from the home', async () => {
		const env = new FixedEnv({});
		expect(env.cwd).toBe('/home/ada');
		expect(await env.absolutePath('~/sub/../b')).toEqual({ ok: true, value: '/home/ada/b' });
	});

	it('resolves the path, awaits the classifier with the path and the hint, and checks the abort first', async () => {
		const files = new FixedEnv({ '/home/ada/a.txt': 'one' });
		const missing = await files.readTextFile('b.txt');
		expect(!missing.ok && missing.error.path).toBe('/home/ada/b.txt');
		const listed = await files.listDir('d');
		expect(!listed.ok && [listed.error.message, listed.error.path]).toEqual([
			'Error: no list',
			'/home/ada/d',
		]);
		const info = await files.fileInfo('d');
		expect(!info.ok && info.error.message).toBe('Error: no info');
		expect(files.hints).toEqual(['file', 'directory', 'any']);

		const controller = new AbortController();
		controller.abort();
		const aborted = await files.readTextFile('a.txt', controller.signal);
		expect(!aborted.ok && [aborted.error.code, aborted.error.path]).toEqual([
			'aborted',
			'/home/ada/a.txt',
		]);
		expect(files.calls).toEqual(['readText /home/ada/b.txt']);
		expect(files.hints).toEqual(['file', 'directory', 'any']);
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
