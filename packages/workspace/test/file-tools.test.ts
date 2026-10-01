/**
 * The `read`, `write`, and `edit` tools on both bash backends: the text a
 * call returns, its details, the error it throws, and the file it leaves.
 * The expected values are the output of the file tools of Pi, which these
 * tools reproduce.
 */
import type { ToolContent } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { backends } from '../../just-bash/test/support/backends.ts';
import type { BashBackend } from '../src/backend.ts';
import { openWorkspace } from '../src/index.ts';
import { callAs, toolOf } from './support/backends.ts';

const agent = { name: 'scribe' };
const home = '/home/scribe';

/** The signature and the shortest valid `IHDR` header: enough for image detection to see a PNG. */
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/** A BMP header of one color plane and 24 bits for each pixel, with no pixels. */
const BMP = new Uint8Array(54);
BMP.set([0x42, 0x4d], 0);
BMP[10] = 54;
BMP[14] = 40;
BMP[26] = 1;
BMP[28] = 24;

const numbered = (count: number, from = 1): string[] =>
	Array.from({ length: count }, (_, index) => `line ${from + index}`);

const text = (value: string): ToolContent[] => [{ type: 'text', text: value }];

interface Case {
	readonly name: string;
	readonly tool: 'read' | 'write' | 'edit';
	/** Files in the home of the agent before the call. */
	readonly files?: Record<string, string | Uint8Array>;
	readonly args: unknown;
	/** What the call returns, or the error it throws. */
	readonly content?: ToolContent[];
	readonly details?: unknown;
	readonly error?: { readonly message?: string; readonly code?: string };
	/** The text of files in the home of the agent after the call. */
	readonly after?: Record<string, string>;
}

const edit = (oldText: string, newText: string) => ({ oldText, newText });
const replaced = (blocks: number) => text(`Successfully replaced ${blocks} block(s) in f.txt.`);

const sizeLimit = 'x'.repeat(1024);
const sizeLimited = Array.from({ length: 100 }, () => sizeLimit);

const cases: readonly Case[] = [
	{
		name: 'a text file',
		tool: 'read',
		files: { 'a.txt': 'one\ntwo\nthree\n' },
		args: { path: 'a.txt' },
		content: text('one\ntwo\nthree\n'),
	},
	{
		name: 'a path that starts with @',
		tool: 'read',
		files: { 'a.txt': 'hi' },
		args: { path: '@a.txt' },
		content: text('hi'),
	},
	{
		name: 'lines from an offset to a limit',
		tool: 'read',
		files: { 'a.txt': numbered(10).join('\n') },
		args: { path: 'a.txt', offset: 3, limit: 2 },
		content: text('line 3\nline 4\n\n[6 more lines in file. Use offset=5 to continue.]'),
	},
	{
		name: 'a limit past the end of the file',
		tool: 'read',
		files: { 'a.txt': numbered(10).join('\n') },
		args: { path: 'a.txt', offset: 9, limit: 5 },
		content: text('line 9\nline 10'),
	},
	{
		name: 'an offset past the end of the file',
		tool: 'read',
		files: { 'a.txt': 'one\ntwo' },
		args: { path: 'a.txt', offset: 99 },
		error: { message: 'Offset 99 is beyond end of file (2 lines total)' },
	},
	{
		name: 'a file over the line limit',
		tool: 'read',
		files: { 'a.txt': numbered(2500).join('\n') },
		args: { path: 'a.txt' },
		content: text(
			`${numbered(2000).join('\n')}\n\n[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]`,
		),
		details: {
			truncation: {
				content: numbered(2000).join('\n'),
				truncated: true,
				truncatedBy: 'lines',
				totalLines: 2500,
				totalBytes: 23892,
				outputLines: 2000,
				outputBytes: 18892,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines: 2000,
				maxBytes: 51200,
			},
		},
	},
	{
		name: 'a file over the byte limit',
		tool: 'read',
		files: { 'a.txt': sizeLimited.join('\n') },
		args: { path: 'a.txt' },
		content: text(
			`${sizeLimited.slice(0, 49).join('\n')}\n\n[Showing lines 1-49 of 100 (50.0KB limit). Use offset=50 to continue.]`,
		),
		details: {
			truncation: {
				content: sizeLimited.slice(0, 49).join('\n'),
				truncated: true,
				truncatedBy: 'bytes',
				totalLines: 100,
				totalBytes: 102499,
				outputLines: 49,
				outputBytes: 50224,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines: 2000,
				maxBytes: 51200,
			},
		},
	},
	{
		name: 'a first line over the byte limit',
		tool: 'read',
		files: { 'a.txt': 'y'.repeat(60_000) },
		args: { path: 'a.txt' },
		content: text(
			"[Line 1 is 58.6KB, exceeds 50.0KB limit. Use bash: sed -n '1p' a.txt | head -c 51200]",
		),
		details: {
			truncation: {
				content: '',
				truncated: true,
				truncatedBy: 'bytes',
				totalLines: 1,
				totalBytes: 60_000,
				outputLines: 0,
				outputBytes: 0,
				lastLinePartial: false,
				firstLineExceedsLimit: true,
				maxLines: 2000,
				maxBytes: 51200,
			},
		},
	},
	{
		name: 'a PNG image',
		tool: 'read',
		files: { 'pic.png': PNG },
		args: { path: 'pic.png' },
		content: [
			{ type: 'text', text: 'Read image file [image/png]' },
			{ type: 'image', data: 'iVBORw0KGgoAAAANSUhEUg==', mimeType: 'image/png' },
			{ type: 'text', text: `Image path: ${home}/pic.png` },
		],
	},
	{
		name: 'a BMP image, which has no image part',
		tool: 'read',
		files: { 'pic.bmp': BMP },
		args: { path: 'pic.bmp' },
		content: [
			{
				type: 'text',
				text: 'Read image file [image/bmp]\n[Image omitted: BMP has no image part. Convert the file to PNG with bash to see it.]',
			},
			{ type: 'text', text: `Image path: ${home}/pic.bmp` },
		],
	},
	{
		name: 'a file that does not exist',
		tool: 'read',
		args: { path: 'nope.txt' },
		error: { code: 'not_found' },
	},
	{
		name: 'a directory',
		tool: 'read',
		files: { 'd/x.txt': 'x' },
		args: { path: 'd' },
		error: { code: 'is_directory' },
	},
	{
		name: 'a new file',
		tool: 'write',
		args: { path: 'x.txt', content: 'hello' },
		content: text('Successfully wrote to x.txt'),
		after: { 'x.txt': 'hello' },
	},
	{
		name: 'a new file in nested directories',
		tool: 'write',
		args: { path: 'a/b/c.txt', content: 'deep' },
		content: text('Successfully wrote to a/b/c.txt'),
		after: { 'a/b/c.txt': 'deep' },
	},
	{
		name: 'a file that exists',
		tool: 'write',
		files: { 'x.txt': 'old' },
		args: { path: 'x.txt', content: 'new' },
		content: text('Successfully wrote to x.txt'),
		after: { 'x.txt': 'new' },
	},
	{
		name: 'one replacement',
		tool: 'edit',
		files: { 'f.txt': 'alpha\nbeta\ngamma\n' },
		args: { path: 'f.txt', edits: [edit('beta', 'BETA')] },
		content: replaced(1),
		details: {
			diff: ' 1 alpha\n-2 beta\n+2 BETA\n 3 gamma',
			patch: '--- f.txt\n+++ f.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n',
			firstChangedLine: 2,
		},
		after: { 'f.txt': 'alpha\nBETA\ngamma\n' },
	},
	{
		name: 'two replacements far apart, which the diff shortens',
		tool: 'edit',
		files: { 'f.txt': `${numbered(40).join('\n')}\n` },
		args: {
			path: 'f.txt',
			edits: [edit('line 5\n', 'five\n'), edit('line 35\n', 'thirty-five\n')],
		},
		content: replaced(2),
		details: {
			diff: [
				'  1 line 1',
				'  2 line 2',
				'  3 line 3',
				'  4 line 4',
				'- 5 line 5',
				'+ 5 five',
				'  6 line 6',
				'  7 line 7',
				'  8 line 8',
				'  9 line 9',
				'    ...',
				' 31 line 31',
				' 32 line 32',
				' 33 line 33',
				' 34 line 34',
				'-35 line 35',
				'+35 thirty-five',
				' 36 line 36',
				' 37 line 37',
				' 38 line 38',
				' 39 line 39',
				'    ...',
			].join('\n'),
			patch: `--- f.txt\n+++ f.txt\n@@ -1,9 +1,9 @@\n${[
				...numbered(4),
				'-line 5',
				'+five',
				...numbered(4, 6),
			]
				.map((line) => (/^[-+]/.test(line) ? line : ` ${line}`))
				.join('\n')}\n@@ -31,9 +31,9 @@\n${[
				...numbered(4, 31),
				'-line 35',
				'+thirty-five',
				...numbered(4, 36),
			]
				.map((line) => (/^[-+]/.test(line) ? line : ` ${line}`))
				.join('\n')}\n`,
			firstChangedLine: 5,
		},
		after: {
			'f.txt': `${[...numbered(4), 'five', ...numbered(29, 6), 'thirty-five', ...numbered(5, 36)].join('\n')}\n`,
		},
	},
	{
		name: 'oldText and newText beside the path',
		tool: 'edit',
		files: { 'f.txt': 'alpha\nbeta\n' },
		args: { path: 'f.txt', oldText: 'alpha', newText: 'ALPHA' },
		content: replaced(1),
		details: {
			diff: '-1 alpha\n+1 ALPHA\n 2 beta',
			patch: '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-alpha\n+ALPHA\n beta\n',
			firstChangedLine: 1,
		},
		after: { 'f.txt': 'ALPHA\nbeta\n' },
	},
	{
		name: 'oldText and newText that join the edits',
		tool: 'edit',
		files: { 'f.txt': 'alpha\nbeta\n' },
		args: { path: 'f.txt', edits: [edit('alpha', 'A')], oldText: 'beta', newText: 'B' },
		content: replaced(2),
		details: {
			diff: '-1 alpha\n-2 beta\n+1 A\n+2 B',
			patch: '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-alpha\n-beta\n+A\n+B\n',
			firstChangedLine: 1,
		},
		after: { 'f.txt': 'A\nB\n' },
	},
	{
		name: 'edits as a JSON string',
		tool: 'edit',
		files: { 'f.txt': 'alpha\nbeta\n' },
		args: { path: 'f.txt', edits: '[{"oldText":"alpha","newText":"A"}]' },
		content: replaced(1),
		details: {
			diff: '-1 alpha\n+1 A\n 2 beta',
			patch: '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-alpha\n+A\n beta\n',
			firstChangedLine: 1,
		},
		after: { 'f.txt': 'A\nbeta\n' },
	},
	{
		name: 'edits as one JSON object',
		tool: 'edit',
		files: { 'f.txt': 'alpha\nbeta\n' },
		args: { path: 'f.txt', edits: '{"oldText":"beta","newText":"B"}' },
		content: replaced(1),
		details: {
			diff: ' 1 alpha\n-2 beta\n+2 B',
			patch: '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+B\n',
			firstChangedLine: 2,
		},
		after: { 'f.txt': 'alpha\nB\n' },
	},
	{
		name: 'edits as one object',
		tool: 'edit',
		files: { 'f.txt': 'alpha\nbeta\n' },
		args: { path: 'f.txt', edits: edit('beta', 'B') },
		content: replaced(1),
		details: {
			diff: ' 1 alpha\n-2 beta\n+2 B',
			patch: '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+B\n',
			firstChangedLine: 2,
		},
		after: { 'f.txt': 'alpha\nB\n' },
	},
	{
		name: 'text that is not in the file',
		tool: 'edit',
		files: { 'f.txt': 'alpha\n' },
		args: { path: 'f.txt', edits: [edit('zeta', 'Z')] },
		error: {
			message:
				'Could not find the exact text in f.txt. The old text must match exactly including all whitespace and newlines.',
		},
		after: { 'f.txt': 'alpha\n' },
	},
	{
		name: 'the second of two edits that is not in the file',
		tool: 'edit',
		files: { 'f.txt': 'alpha\n' },
		args: { path: 'f.txt', edits: [edit('alpha', 'A'), edit('zeta', 'Z')] },
		error: {
			message:
				'Could not find edits[1] in f.txt. The oldText must match exactly including all whitespace and newlines.',
		},
		after: { 'f.txt': 'alpha\n' },
	},
	{
		name: 'text that occurs twice',
		tool: 'edit',
		files: { 'f.txt': 'a\nb\na\n' },
		args: { path: 'f.txt', edits: [edit('a', 'z')] },
		error: {
			message:
				'Found 2 occurrences of the text in f.txt. The text must be unique. Please provide more context to make it unique.',
		},
	},
	{
		name: 'two edits that overlap',
		tool: 'edit',
		files: { 'f.txt': 'abcdef\n' },
		args: { path: 'f.txt', edits: [edit('abc', 'x'), edit('cde', 'y')] },
		error: {
			message:
				'edits[0] and edits[1] overlap in f.txt. Merge them into one edit or target disjoint regions.',
		},
	},
	{
		name: 'an empty oldText',
		tool: 'edit',
		files: { 'f.txt': 'a\n' },
		args: { path: 'f.txt', edits: [edit('', 'z')] },
		error: { message: 'oldText must not be empty in f.txt.' },
	},
	{
		name: 'an empty list of edits',
		tool: 'edit',
		files: { 'f.txt': 'a\n' },
		args: { path: 'f.txt', edits: [] },
		error: { message: 'Edit tool input is invalid. edits must contain at least one replacement.' },
	},
	{
		name: 'an edit that changes nothing',
		tool: 'edit',
		files: { 'f.txt': 'a\n' },
		args: { path: 'f.txt', edits: [edit('a', 'a')] },
		error: {
			message:
				'No changes made to f.txt. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.',
		},
	},
	{
		name: 'a file with CRLF line endings, which stay',
		tool: 'edit',
		files: { 'f.txt': 'a\r\nb\r\nc\r\n' },
		args: { path: 'f.txt', edits: [edit('a\nb', 'x\ny\nz')] },
		content: replaced(1),
		details: {
			diff: '-1 a\n-2 b\n+1 x\n+2 y\n+3 z\n 3 c',
			patch: '--- f.txt\n+++ f.txt\n@@ -1,3 +1,4 @@\n-a\n-b\n+x\n+y\n+z\n c\n',
			firstChangedLine: 1,
		},
		after: { 'f.txt': 'x\r\ny\r\nz\r\nc\r\n' },
	},
	{
		name: 'text with typographic quotes, which an ASCII oldText matches',
		tool: 'edit',
		files: { 'f.txt': 'say “hi”  \nnext — line\nlast\n' },
		args: { path: 'f.txt', edits: [edit('say "hi"', 'say "bye"')] },
		content: replaced(1),
		details: {
			diff: '-1 say “hi”  \n+1 say "bye"\n 2 next — line\n 3 last',
			patch:
				'--- f.txt\n+++ f.txt\n@@ -1,3 +1,3 @@\n-say “hi”  \n+say "bye"\n next — line\n last\n',
			firstChangedLine: 1,
		},
		after: { 'f.txt': 'say "bye"\nnext — line\nlast\n' },
	},
	{
		name: 'two fuzzy matches, with the lines between them unchanged',
		tool: 'edit',
		files: { 'f.txt': 'keep  \nit’s one\nkeep2  \nit’s two\n' },
		args: { path: 'f.txt', edits: [edit("it's one", 'ONE'), edit('it’s two', 'TWO')] },
		content: replaced(2),
		details: {
			diff: ' 1 keep  \n-2 it’s one\n+2 ONE\n 3 keep2  \n-4 it’s two\n+4 TWO',
			patch:
				'--- f.txt\n+++ f.txt\n@@ -1,4 +1,4 @@\n keep  \n-it’s one\n+ONE\n keep2  \n-it’s two\n+TWO\n',
			firstChangedLine: 2,
		},
		after: { 'f.txt': 'keep  \nONE\nkeep2  \nTWO\n' },
	},
	{
		name: 'a file that does not exist',
		tool: 'edit',
		args: { path: 'nope.txt', edits: [edit('a', 'b')] },
		error: { message: 'Could not edit file: nope.txt. Error code: not_found.' },
	},
	{
		name: 'a directory',
		tool: 'edit',
		files: { 'd/x.txt': 'x' },
		args: { path: 'd', edits: [edit('a', 'b')] },
		error: { message: 'Could not edit file: d. Path is not a file.' },
	},
];

/** Write each file into the home of the agent through the resource of `site`. */
async function seed(site: ReturnType<typeof openWorkspace>, files: Case['files'] = {}) {
	await site.use(agent, async (env) => {
		for (const [path, content] of Object.entries(files)) {
			const written = await env.writeFile(`${home}/${path}`, content);
			if (!written.ok) throw written.error;
		}
	});
}

/** The text of a file in the home of the agent. */
const textOf = (site: ReturnType<typeof openWorkspace>, path: string) =>
	site.use(agent, async (env) => {
		const read = await env.readTextFile(`${home}/${path}`);
		if (!read.ok) throw read.error;
		return read.value;
	});

/** Call a tool as an executor does: prepare the arguments, then invoke. */
function call(site: ReturnType<typeof openWorkspace>, tool: string, args: unknown) {
	const target = toolOf(site, tool);
	const prepared = target.prepareArguments ? target.prepareArguments(structuredClone(args)) : args;
	return target.invoke(prepared, callAs(agent.name));
}

describe.each(backends)('the file tools on the $name backend', (fixture) => {
	it.each(cases)('$tool: $name', async (item) => {
		const { backend, dispose } = await fixture.open();
		const site = openWorkspace({ name: 'files', backend: { bash: backend } });
		try {
			await seed(site, item.files);
			const outcome = call(site, item.tool, item.args);
			if (item.error !== undefined) {
				await expect(outcome).rejects.toMatchObject(item.error);
			} else {
				await expect(outcome).resolves.toEqual({ content: item.content, details: item.details });
			}
			for (const [path, content] of Object.entries(item.after ?? {})) {
				expect(await textOf(site, path)).toBe(content);
			}
		} finally {
			await site.dispose();
			await dispose();
		}
	});
});

describe('the byte order mark', () => {
	/** A backend whose `readTextFile` keeps a byte order mark, as the file tool needs to keep it. */
	function keepingBom(): BashBackend {
		const inner = memoryBackend();
		return {
			...inner,
			connect: async (who, signal) => {
				const env = await inner.connect(who, signal);
				env.readTextFile = async (path, context) => {
					const bytes = await env.readBinaryFile(path, context);
					return bytes.ok
						? { ok: true, value: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.value) }
						: bytes;
				};
				return env;
			},
		};
	}

	it('stays at the start of a file that edit changes', async () => {
		const site = openWorkspace({ name: 'bom', backend: { bash: keepingBom() } });
		await seed(site, { 'f.txt': '﻿a\nb\n' });
		await call(site, 'edit', { path: 'f.txt', edits: [edit('b', 'B')] });
		expect(await textOf(site, 'f.txt')).toBe('﻿a\nB\n');
		await site.dispose();
	});
});
