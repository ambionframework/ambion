/** A ref names one absolute URI with a scheme. The room refuses a bare path. */
import { describe, expect, it } from 'vitest';
import { refOf } from '../src/tools.ts';

describe('refOf', () => {
	it('turns an absolute path into a file URI', () => {
		expect(refOf('/tmp/codex-cap/file-change/note.txt')).toBe('file:///tmp/codex-cap/file-change/note.txt');
	});

	it('encodes what a URI cannot hold', () => {
		expect(refOf('/tmp/a b/note #1.txt')).toBe('file:///tmp/a%20b/note%20%231.txt');
	});

	it('leaves a URI as it is, and trims it', () => {
		expect(refOf('  ambion://room/lab  ')).toBe('ambion://room/lab');
		expect(refOf('https://example.com/plan')).toBe('https://example.com/plan');
	});

	it('gives every recorded changed path a URI with a scheme', async () => {
		const { changedPaths } = await import('../src/codex-trace.ts');
		const { recorded } = await import('./fixtures.ts');
		const paths = recorded('file-change').flatMap((event) => changedPaths(event));
		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) expect(new URL(refOf(path)).protocol).toBe('file:');
	});
});
