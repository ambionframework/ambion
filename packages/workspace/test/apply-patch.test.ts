/**
 * The `apply_patch` tool on both bash backends: the text a call returns, its
 * details, the error it throws, and the files it leaves. A patch applies in
 * full or not at all, so each error case also checks the files.
 */
import type { ToolContent } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { backends } from '../../just-bash/test/support/backends.ts';
import type { BashBackend } from '../src/backend.ts';
import { openWorkspace } from '../src/index.ts';
import { FileError } from '../src/port.ts';
import { callAs, toolOf } from './support/backends.ts';

const agent = { name: 'scribe' };
const home = '/home/scribe';

type Site = ReturnType<typeof openWorkspace>;

/** A patch: the envelope around the lines. */
const patchOf = (...lines: string[]): string =>
	['*** Begin Patch', ...lines, '*** End Patch'].join('\n');

const text = (value: string): ToolContent[] => [{ type: 'text', text: value }];

interface Case {
	readonly name: string;
	/** Files in the home of the agent before the call. */
	readonly files?: Record<string, string>;
	/** The arguments of the call, before `prepareArguments`. */
	readonly args: unknown;
	/** The text that the call returns. */
	readonly result?: string;
	readonly details?: unknown;
	/** The message that the error holds. */
	readonly error?: string;
	/** The text of files in the home of the agent after the call. */
	readonly after?: Record<string, string>;
	/** Files in the home of the agent that do not exist after the call. */
	readonly absent?: readonly string[];
}

const cases: readonly Case[] = [
	{
		name: 'adds a file in a new directory, with a final newline',
		args: { input: patchOf('*** Add File: docs/new.md', '+hello', '+world') },
		result: 'Applied patch: A docs/new.md',
		details: {
			files: [{ path: 'docs/new.md', action: 'add' }],
			patch: '--- docs/new.md\n+++ docs/new.md\n@@ -0,0 +1,2 @@\n+hello\n+world\n',
		},
		after: { 'docs/new.md': 'hello\nworld\n' },
	},
	{
		name: 'adds a file whose last line is empty, with one final newline',
		args: { input: patchOf('*** Add File: n.txt', '+hello', '+') },
		result: 'Applied patch: A n.txt',
		details: {
			files: [{ path: 'n.txt', action: 'add' }],
			patch: '--- n.txt\n+++ n.txt\n@@ -0,0 +1,1 @@\n+hello\n',
		},
		after: { 'n.txt': 'hello\n' },
	},
	{
		name: 'adds an empty file',
		args: { input: patchOf('*** Add File: empty.txt') },
		result: 'Applied patch: A empty.txt',
		details: {
			files: [{ path: 'empty.txt', action: 'add' }],
			patch: '--- empty.txt\n+++ empty.txt\n',
		},
		after: { 'empty.txt': '' },
	},
	{
		name: 'adds a file at an absolute path',
		args: { input: patchOf(`*** Add File: ${home}/abs.txt`, '+x') },
		result: `Applied patch: A ${home}/abs.txt`,
		details: {
			files: [{ path: `${home}/abs.txt`, action: 'add' }],
			patch: `--- ${home}/abs.txt\n+++ ${home}/abs.txt\n@@ -0,0 +1,1 @@\n+x\n`,
		},
		after: { 'abs.txt': 'x\n' },
	},
	{
		name: 'adds a file over a file that exists, which it replaces',
		files: { 'a.txt': 'old\n' },
		args: { input: patchOf('*** Add File: a.txt', '+new') },
		result: 'Applied patch: A a.txt',
		details: {
			files: [{ path: 'a.txt', action: 'add' }],
			patch: '--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n',
		},
		after: { 'a.txt': 'new\n' },
	},
	{
		name: 'deletes a file',
		files: { 'old.txt': 'a\nb\n', 'keep.txt': 'k\n' },
		args: { input: patchOf('*** Delete File: old.txt') },
		result: 'Applied patch: D old.txt',
		details: {
			files: [{ path: 'old.txt', action: 'delete' }],
			patch: '--- old.txt\n+++ old.txt\n@@ -1,2 +0,0 @@\n-a\n-b\n',
		},
		after: { 'keep.txt': 'k\n' },
		absent: ['old.txt'],
	},
	{
		name: 'updates one chunk',
		files: { 'src/a.ts': 'one\ntwo\nthree\n' },
		args: { input: patchOf('*** Update File: src/a.ts', ' one', '-two', '+TWO', ' three') },
		result: 'Applied patch: M src/a.ts',
		details: {
			files: [{ path: 'src/a.ts', action: 'update' }],
			patch: '--- src/a.ts\n+++ src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n',
		},
		after: { 'src/a.ts': 'one\nTWO\nthree\n' },
	},
	{
		name: 'updates several chunks of one file',
		files: { 'f.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n' },
		args: {
			input: patchOf('*** Update File: f.txt', '-a', '+A', ' b', '@@', ' g', '-h', '+H'),
		},
		result: 'Applied patch: M f.txt',
		details: {
			files: [{ path: 'f.txt', action: 'update' }],
			patch: '--- f.txt\n+++ f.txt\n@@ -1,8 +1,8 @@\n-a\n+A\n b\n c\n d\n e\n f\n g\n-h\n+H\n',
		},
		after: { 'f.txt': 'A\nb\nc\nd\ne\nf\ng\nH\n' },
	},
	{
		name: 'updates at an @@ anchor',
		files: {
			'm.py':
				'class A:\n    def run(self):\n        pass\n\nclass B:\n    def run(self):\n        pass\n',
		},
		args: {
			input: patchOf(
				'*** Update File: m.py',
				'@@ class B:',
				'@@     def run(self):',
				'-        pass',
				'+        return 1',
			),
		},
		result: 'Applied patch: M m.py',
		details: {
			files: [{ path: 'm.py', action: 'update' }],
			patch:
				'--- m.py\n+++ m.py\n@@ -3,5 +3,5 @@\n         pass\n \n class B:\n     def run(self):\n-        pass\n+        return 1\n',
		},
		after: {
			'm.py':
				'class A:\n    def run(self):\n        pass\n\nclass B:\n    def run(self):\n        return 1\n',
		},
	},
	{
		name: 'updates the end of a file with End of File',
		files: { 'f.txt': 'x\nfoo\ny\nfoo\n' },
		args: { input: patchOf('*** Update File: f.txt', ' foo', '+added', '*** End of File') },
		result: 'Applied patch: M f.txt',
		details: {
			files: [{ path: 'f.txt', action: 'update' }],
			patch: '--- f.txt\n+++ f.txt\n@@ -1,4 +1,5 @@\n x\n foo\n y\n foo\n+added\n',
		},
		after: { 'f.txt': 'x\nfoo\ny\nfoo\nadded\n' },
	},
	{
		name: 'moves a file with no change to its content',
		files: { 'old.txt': 'a\nb\n' },
		args: { input: patchOf('*** Update File: old.txt', '*** Move to: new/place.txt') },
		result: 'Applied patch: M old.txt -> new/place.txt',
		details: {
			files: [{ path: 'old.txt', action: 'move', to: 'new/place.txt' }],
			patch: '--- old.txt\n+++ new/place.txt\n',
		},
		after: { 'new/place.txt': 'a\nb\n' },
		absent: ['old.txt'],
	},
	{
		name: 'moves a file and changes its content',
		files: { 'src/a.ts': 'one\ntwo\n' },
		args: {
			input: patchOf('*** Update File: src/a.ts', '*** Move to: src/b.ts', ' one', '-two', '+2'),
		},
		result: 'Applied patch: M src/a.ts -> src/b.ts',
		details: {
			files: [{ path: 'src/a.ts', action: 'move', to: 'src/b.ts' }],
			patch: '--- src/a.ts\n+++ src/b.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n',
		},
		after: { 'src/b.ts': 'one\n2\n' },
		absent: ['src/a.ts'],
	},
	{
		name: 'moves a file onto a file that exists, which it replaces',
		files: { 'a.txt': 'a\n', 'b.txt': 'b\n' },
		args: { input: patchOf('*** Update File: a.txt', '*** Move to: b.txt') },
		result: 'Applied patch: M a.txt -> b.txt',
		details: {
			files: [{ path: 'a.txt', action: 'move', to: 'b.txt' }],
			patch: '--- a.txt\n+++ b.txt\n',
		},
		after: { 'b.txt': 'a\n' },
		absent: ['a.txt'],
	},
	{
		name: 'moves a file onto its own path, which keeps it',
		files: { 'a.txt': 'a\n' },
		args: { input: patchOf('*** Update File: a.txt', '*** Move to: ./a.txt', '-a', '+A') },
		result: 'Applied patch: M a.txt -> ./a.txt',
		details: {
			files: [{ path: 'a.txt', action: 'move', to: './a.txt' }],
			patch: '--- a.txt\n+++ ./a.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n',
		},
		after: { 'a.txt': 'A\n' },
	},
	{
		name: 'changes many files in one call',
		files: { 'old.txt': 'gone\n', 'src/a.ts': 'one\ntwo\n', 'mv.txt': 'm\n' },
		args: {
			input: patchOf(
				'*** Add File: docs/new.md',
				'+# New',
				'*** Update File: src/a.ts',
				' one',
				'-two',
				'+2',
				'*** Delete File: old.txt',
				'*** Update File: mv.txt',
				'*** Move to: moved/mv.txt',
			),
		},
		result: 'Applied patch: A docs/new.md, M src/a.ts, D old.txt, M mv.txt -> moved/mv.txt',
		details: {
			files: [
				{ path: 'docs/new.md', action: 'add' },
				{ path: 'src/a.ts', action: 'update' },
				{ path: 'old.txt', action: 'delete' },
				{ path: 'mv.txt', action: 'move', to: 'moved/mv.txt' },
			],
			patch: [
				'--- docs/new.md\n+++ docs/new.md\n@@ -0,0 +1,1 @@\n+# New\n',
				'--- src/a.ts\n+++ src/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n',
				'--- old.txt\n+++ old.txt\n@@ -1,1 +0,0 @@\n-gone\n',
				'--- mv.txt\n+++ moved/mv.txt\n',
			].join(''),
		},
		after: { 'docs/new.md': '# New\n', 'src/a.ts': 'one\n2\n', 'moved/mv.txt': 'm\n' },
		absent: ['old.txt', 'mv.txt'],
	},
	{
		name: 'updates one file twice, so the second update sees the first',
		files: { 'f.txt': 'a\nb\nc\n' },
		args: {
			input: patchOf(
				'*** Update File: f.txt',
				' a',
				'-b',
				'+B',
				'*** Update File: f.txt',
				' B',
				'-c',
				'+C',
			),
		},
		result: 'Applied patch: M f.txt, M f.txt',
		details: {
			files: [
				{ path: 'f.txt', action: 'update' },
				{ path: 'f.txt', action: 'update' },
			],
			patch:
				'--- f.txt\n+++ f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n--- f.txt\n+++ f.txt\n@@ -1,3 +1,3 @@\n a\n B\n-c\n+C\n',
		},
		after: { 'f.txt': 'a\nB\nC\n' },
	},
	{
		name: 'updates a file that the patch adds',
		args: {
			input: patchOf('*** Add File: n.txt', '+one', '*** Update File: n.txt', ' one', '+two'),
		},
		result: 'Applied patch: A n.txt, M n.txt',
		details: {
			files: [
				{ path: 'n.txt', action: 'add' },
				{ path: 'n.txt', action: 'update' },
			],
			patch:
				'--- n.txt\n+++ n.txt\n@@ -0,0 +1,1 @@\n+one\n--- n.txt\n+++ n.txt\n@@ -1,1 +1,2 @@\n one\n+two\n',
		},
		after: { 'n.txt': 'one\ntwo\n' },
	},
	{
		name: 'updates a file at the path where an earlier operation moved it',
		files: { 'a.txt': 'a\n' },
		args: {
			input: patchOf(
				'*** Update File: a.txt',
				'*** Move to: b.txt',
				'*** Update File: b.txt',
				'-a',
				'+b',
			),
		},
		result: 'Applied patch: M a.txt -> b.txt, M b.txt',
		details: {
			files: [
				{ path: 'a.txt', action: 'move', to: 'b.txt' },
				{ path: 'b.txt', action: 'update' },
			],
			patch: '--- a.txt\n+++ b.txt\n--- b.txt\n+++ b.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
		},
		after: { 'b.txt': 'b\n' },
		absent: ['a.txt'],
	},
	{
		name: 'adds a file at a path that an earlier operation deleted',
		files: { 'a.txt': 'old\n' },
		args: { input: patchOf('*** Delete File: a.txt', '*** Add File: a.txt', '+new') },
		result: 'Applied patch: D a.txt, A a.txt',
		details: {
			files: [
				{ path: 'a.txt', action: 'delete' },
				{ path: 'a.txt', action: 'add' },
			],
			patch:
				'--- a.txt\n+++ a.txt\n@@ -1,1 +0,0 @@\n-old\n--- a.txt\n+++ a.txt\n@@ -0,0 +1,1 @@\n+new\n',
		},
		after: { 'a.txt': 'new\n' },
	},
	{
		name: 'keeps CRLF line endings of a file',
		files: { 'w.txt': 'a\r\nb\r\nc\r\n' },
		args: { input: patchOf('*** Update File: w.txt', ' a', '-b', '+B', '+B2', ' c') },
		result: 'Applied patch: M w.txt',
		details: {
			files: [{ path: 'w.txt', action: 'update' }],
			patch: '--- w.txt\n+++ w.txt\n@@ -1,3 +1,4 @@\n a\n-b\n+B\n+B2\n c\n',
		},
		after: { 'w.txt': 'a\r\nB\r\nB2\r\nc\r\n' },
	},
	{
		name: 'keeps CRLF line endings when the patch has them',
		files: { 'w.txt': 'a\r\nb\r\n' },
		args: { input: patchOf('*** Update File: w.txt', ' a', '-b', '+B').replace(/\n/g, '\r\n') },
		result: 'Applied patch: M w.txt',
		details: {
			files: [{ path: 'w.txt', action: 'update' }],
			patch: '--- w.txt\n+++ w.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n',
		},
		after: { 'w.txt': 'a\r\nB\r\n' },
	},
	{
		name: 'keeps a missing final newline',
		files: { 'f.txt': 'a\nb' },
		args: { input: patchOf('*** Update File: f.txt', ' a', '-b', '+B') },
		result: 'Applied patch: M f.txt',
		details: {
			files: [{ path: 'f.txt', action: 'update' }],
			patch:
				'--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n',
		},
		after: { 'f.txt': 'a\nB' },
	},
	{
		name: 'matches context that differs in the whitespace at the end of a line',
		files: { 'f.txt': 'a  \nb\n' },
		args: { input: patchOf('*** Update File: f.txt', ' a', '-b', '+B') },
		result: 'Applied patch: M f.txt',
		details: {
			files: [{ path: 'f.txt', action: 'update' }],
			patch: '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n a  \n-b\n+B\n',
		},
		after: { 'f.txt': 'a  \nB\n' },
	},
	{
		name: 'reads a patch inside a heredoc after apply_patch',
		files: { 'f.txt': 'a\n' },
		args: { input: `apply_patch <<'EOF'\n${patchOf('*** Update File: f.txt', '-a', '+b')}\nEOF\n` },
		result: 'Applied patch: M f.txt',
		details: {
			files: [{ path: 'f.txt', action: 'update' }],
			patch: '--- f.txt\n+++ f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
		},
		after: { 'f.txt': 'b\n' },
	},
	{
		name: 'reads a patch inside a heredoc with an unquoted word',
		args: { input: `<<EOF\n${patchOf('*** Add File: h.txt', '+x')}\nEOF` },
		result: 'Applied patch: A h.txt',
		details: {
			files: [{ path: 'h.txt', action: 'add' }],
			patch: '--- h.txt\n+++ h.txt\n@@ -0,0 +1,1 @@\n+x\n',
		},
		after: { 'h.txt': 'x\n' },
	},
	{
		name: 'reads a patch that has blank lines around it',
		args: { input: `\n\n  ${patchOf('*** Add File: t.txt', '+x')}\n\n` },
		result: 'Applied patch: A t.txt',
		details: {
			files: [{ path: 't.txt', action: 'add' }],
			patch: '--- t.txt\n+++ t.txt\n@@ -0,0 +1,1 @@\n+x\n',
		},
		after: { 't.txt': 'x\n' },
	},
	{
		name: 'takes the patch as a bare string',
		args: patchOf('*** Add File: s.txt', '+x'),
		result: 'Applied patch: A s.txt',
		details: {
			files: [{ path: 's.txt', action: 'add' }],
			patch: '--- s.txt\n+++ s.txt\n@@ -0,0 +1,1 @@\n+x\n',
		},
		after: { 's.txt': 'x\n' },
	},
	{
		name: 'takes the patch under the name patch',
		args: { patch: patchOf('*** Add File: p.txt', '+x') },
		result: 'Applied patch: A p.txt',
		details: {
			files: [{ path: 'p.txt', action: 'add' }],
			patch: '--- p.txt\n+++ p.txt\n@@ -0,0 +1,1 @@\n+x\n',
		},
		after: { 'p.txt': 'x\n' },
	},
	{
		name: 'a patch with no Begin Patch line',
		args: { input: '*** Add File: a.txt\n+x\n*** End Patch' },
		error:
			'Invalid patch: The patch must start with "*** Begin Patch" and end with "*** End Patch", each on its own line.\nNothing was written. Fix the patch and send it again.',
		absent: ['a.txt'],
	},
	{
		name: 'a patch with no End Patch line',
		args: { input: '*** Begin Patch\n*** Add File: a.txt\n+x' },
		error:
			'Invalid patch: The patch must start with "*** Begin Patch" and end with "*** End Patch", each on its own line.\nNothing was written. Fix the patch and send it again.',
		absent: ['a.txt'],
	},
	{
		name: 'a patch with no operation',
		args: { input: patchOf() },
		error:
			'Invalid patch: The patch holds no operation.\nNothing was written. Fix the patch and send it again.',
	},
	{
		name: 'a patch with a line before the first operation',
		args: { input: patchOf('+x', '*** Add File: a.txt', '+x') },
		error:
			'Invalid patch: Line 2 of the patch must start an operation with "*** Add File:", "*** Delete File:", or "*** Update File:". It reads: +x\nNothing was written. Fix the patch and send it again.',
		absent: ['a.txt'],
	},
	{
		name: 'a patch with an unknown *** line',
		files: { 'f.txt': 'a\n' },
		args: {
			input: patchOf(
				'*** Add File: a.txt',
				'+x',
				'*** Update File: f.txt',
				'*** Rename File: g.txt',
			),
		},
		error:
			'Invalid patch: Line 5 of the patch is not valid here: *** Rename File: g.txt\nNothing was written. Fix the patch and send it again.',
		after: { 'f.txt': 'a\n' },
		absent: ['a.txt'],
	},
	{
		name: 'a patch with a second Begin Patch line',
		args: { input: patchOf('*** Add File: a.txt', '+x', '*** Begin Patch') },
		error:
			'Invalid patch: Line 4 of the patch is not valid here: *** Begin Patch\nNothing was written. Fix the patch and send it again.',
		absent: ['a.txt'],
	},
	{
		name: 'a patch with an End Patch line before its end',
		args: {
			input: patchOf('*** Add File: a.txt', '+x', '*** End Patch', '*** Add File: b.txt', '+y'),
		},
		error:
			'Invalid patch: Line 4 of the patch is not valid here: *** End Patch\nNothing was written. Fix the patch and send it again.',
		absent: ['a.txt', 'b.txt'],
	},
	{
		name: 'a Move to line outside an update',
		args: { input: patchOf('*** Add File: a.txt', '*** Move to: b.txt') },
		error:
			'Invalid patch: Line 3 of the patch is not valid here: *** Move to: b.txt\nNothing was written. Fix the patch and send it again.',
		absent: ['a.txt', 'b.txt'],
	},
	{
		name: 'an operation that names no path',
		args: { input: patchOf('*** Add File:   ', '+x') },
		error:
			'Invalid patch: Line 2 of the patch names no path.\nNothing was written. Fix the patch and send it again.',
	},
	{
		name: 'a Move to line that names no path',
		files: { 'a.txt': 'a\n' },
		args: { input: patchOf('*** Update File: a.txt', '*** Move to:') },
		error:
			'Invalid patch: Line 3 of the patch names no path.\nNothing was written. Fix the patch and send it again.',
		after: { 'a.txt': 'a\n' },
	},
	{
		name: 'a Delete File with lines after it',
		files: { 'a.txt': 'a\n' },
		args: { input: patchOf('*** Delete File: a.txt', '-a') },
		error:
			'Invalid patch: The operation "Delete File: a.txt" takes no lines after its header.\nNothing was written. Fix the patch and send it again.',
		after: { 'a.txt': 'a\n' },
	},
	{
		name: 'an update of a file that does not exist',
		args: { input: patchOf('*** Update File: nope.txt', '-a', '+b') },
		error:
			'Could not apply patch to nope.txt (Update File): The file does not exist.\nNothing was written. Read the file and send the patch again.',
		absent: ['nope.txt'],
	},
	{
		name: 'a delete of a file that does not exist',
		files: { 'a.txt': 'a\n' },
		args: { input: patchOf('*** Update File: a.txt', '-a', '+b', '*** Delete File: nope.txt') },
		error:
			'Could not apply patch to nope.txt (Delete File): The file does not exist.\nNothing was written. Read the file and send the patch again.',
		after: { 'a.txt': 'a\n' },
	},
	{
		name: 'an update of a file that an earlier operation deleted',
		files: { 'a.txt': 'a\n' },
		args: { input: patchOf('*** Delete File: a.txt', '*** Update File: a.txt', '-a', '+b') },
		error:
			'Could not apply patch to a.txt (Update File): The file does not exist.\nNothing was written. Read the file and send the patch again.',
		after: { 'a.txt': 'a\n' },
	},
	{
		name: 'an update of a directory',
		files: { 'd/x.txt': 'x\n' },
		args: { input: patchOf('*** Update File: d', '-a', '+b') },
		error:
			'Could not apply patch to d (Update File): Could not edit file: d. Path is not a file.\nNothing was written. Read the file and send the patch again.',
		after: { 'd/x.txt': 'x\n' },
	},
	{
		name: 'a delete of a directory',
		files: { 'd/x.txt': 'x\n' },
		args: { input: patchOf('*** Delete File: d') },
		error:
			'Could not apply patch to d (Delete File): Could not edit file: d. Path is not a file.\nNothing was written. Read the file and send the patch again.',
		after: { 'd/x.txt': 'x\n' },
	},
	{
		name: 'an add over a directory',
		files: { 'd/x.txt': 'x\n' },
		args: { input: patchOf('*** Add File: d', '+a') },
		error:
			'Could not apply patch to d (Add File): Could not edit file: d. Path is not a file.\nNothing was written. Read the file and send the patch again.',
		after: { 'd/x.txt': 'x\n' },
	},
	{
		name: 'a move onto a directory',
		files: { 'a.txt': 'a\n', 'd/x.txt': 'x\n' },
		args: { input: patchOf('*** Update File: a.txt', '*** Move to: d') },
		error:
			'Could not apply patch to a.txt (Update File): Could not edit file: d. Path is not a file.\nNothing was written. Read the file and send the patch again.',
		after: { 'a.txt': 'a\n', 'd/x.txt': 'x\n' },
	},
	{
		name: 'an update with no change and no move',
		files: { 'a.txt': 'a\n' },
		args: { input: patchOf('*** Update File: a.txt') },
		error:
			'Could not apply patch to a.txt (Update File): The update holds no change.\nNothing was written. Read the file and send the patch again.',
		after: { 'a.txt': 'a\n' },
	},
	{
		name: 'an add with a line that does not start with +',
		args: { input: patchOf('*** Add File: a.txt', '+x', 'y') },
		error:
			'Could not apply patch to a.txt (Add File): Invalid Add File Line: y\nNothing was written. Read the file and send the patch again.',
		absent: ['a.txt'],
	},
	{
		name: 'a context that does not match in the second file, which leaves the first file as it was',
		files: { 'one.txt': 'a\nb\n', 'two.txt': 'x\ny\n', 'old.txt': 'old\n' },
		args: {
			input: patchOf(
				'*** Add File: new.txt',
				'+n',
				'*** Update File: one.txt',
				' a',
				'-b',
				'+B',
				'*** Delete File: old.txt',
				'*** Update File: two.txt',
				' x',
				'-nope',
				'+Y',
			),
		},
		error:
			'Could not apply patch to two.txt (Update File): Invalid Context 0:\nx\nnope\nNothing was written. Read the file and send the patch again.',
		after: { 'one.txt': 'a\nb\n', 'two.txt': 'x\ny\n', 'old.txt': 'old\n' },
		absent: ['new.txt'],
	},
	{
		name: 'an anchor that is not in the file',
		files: { 'a.txt': 'a\nb\n' },
		args: { input: patchOf('*** Update File: a.txt', '@@ missing', '@@', '-b', '+B') },
		error:
			'Could not apply patch to a.txt (Update File): Invalid Anchor 0:\nmissing\nNothing was written. Read the file and send the patch again.',
		after: { 'a.txt': 'a\nb\n' },
	},
];

/** Write each file into the home of the agent through the resource of `site`. */
async function seed(site: Site, files: Case['files'] = {}) {
	await site.use(agent, async (env) => {
		for (const [path, content] of Object.entries(files)) {
			const written = await env.writeFile(`${home}/${path}`, content);
			if (!written.ok) throw written.error;
		}
	});
}

/** The text of a file in the home of the agent. */
const textOf = (site: Site, path: string) =>
	site.use(agent, async (env) => {
		const read = await env.readTextFile(`${home}/${path}`);
		if (!read.ok) throw read.error;
		return read.value;
	});

const existsIn = (site: Site, path: string) =>
	site.use(agent, async (env) => {
		const found = await env.exists(`${home}/${path}`);
		return found.ok && found.value;
	});

/** Call the tool as an executor does: prepare the arguments, then invoke. */
function call(site: Site, args: unknown, context = callAs(agent.name)) {
	const target = toolOf(site, 'apply_patch');
	const prepared = target.prepareArguments ? target.prepareArguments(structuredClone(args)) : args;
	return target.invoke(prepared, context);
}

describe.each(backends)('the apply_patch tool on the $name backend', (fixture) => {
	it.each(cases)('$name', async (item) => {
		const { backend, dispose } = await fixture.open();
		const site = openWorkspace({ name: 'patches', backend: { bash: backend } });
		try {
			await seed(site, item.files);
			const outcome = call(site, item.args);
			if (item.error !== undefined) {
				await expect(outcome).rejects.toThrow(item.error);
			} else {
				await expect(outcome).resolves.toEqual({
					content: text(item.result ?? ''),
					details: item.details,
				});
			}
			for (const [path, content] of Object.entries(item.after ?? {})) {
				expect(await textOf(site, path), path).toBe(content);
			}
			for (const path of item.absent ?? []) expect(await existsIn(site, path), path).toBe(false);
		} finally {
			await site.dispose();
			await dispose();
		}
	});
});

describe('the byte order mark', () => {
	/** A backend whose `readTextFile` keeps a byte order mark, as the file tools need to keep it. */
	function keepingBom(): BashBackend {
		const inner = memoryBackend();
		return {
			...inner,
			connect: async (who, signal) => {
				const env = await inner.connect(who, signal);
				env.readTextFile = async (path, signal) => {
					const bytes = await env.readBinaryFile(path, signal);
					return bytes.ok
						? { ok: true, value: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.value) }
						: bytes;
				};
				return env;
			},
		};
	}

	it('stays at the start of a file that a patch updates, and of a file that it moves', async () => {
		const site = openWorkspace({ name: 'bom', backend: { bash: keepingBom() } });
		await seed(site, { 'a.txt': '\uFEFFa\nb\n', 'c.txt': '\uFEFFc\n' });
		const result = await call(
			site,
			patchOf(
				'*** Update File: a.txt',
				' a',
				'-b',
				'+B',
				'*** Update File: c.txt',
				'*** Move to: d.txt',
				'-c',
				'+C',
			),
		);
		expect(result).toMatchObject({
			details: {
				patch:
					'--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n--- c.txt\n+++ d.txt\n@@ -1,1 +1,1 @@\n-c\n+C\n',
			},
		});
		expect(await textOf(site, 'a.txt')).toBe('\uFEFFa\nB\n');
		expect(await textOf(site, 'd.txt')).toBe('\uFEFFC\n');
		await site.dispose();
	});
});

describe('an abort or a failure during a call', () => {
	/** A backend that changes `readTextFile` and `writeFile` of its files, as the case needs. */
	function through(
		change: (env: Awaited<ReturnType<BashBackend['connect']>>) => void,
	): BashBackend {
		const inner = memoryBackend();
		return {
			...inner,
			connect: async (who, signal) => {
				const env = await inner.connect(who, signal);
				change(env);
				return env;
			},
		};
	}

	it('stops before any call when the signal is already aborted', async () => {
		const site = openWorkspace({ name: 'cut', backend: { bash: memoryBackend() } });
		const controller = new AbortController();
		controller.abort();
		const outcome = call(
			site,
			patchOf('*** Add File: a.txt', '+x'),
			callAs(agent.name, { signal: controller.signal }),
		);
		await expect(outcome).rejects.toThrow('This operation was aborted');
		expect(await existsIn(site, 'a.txt')).toBe(false);
		await site.dispose();
	});

	it('stops after the read of the files, before it writes, and leaves every file as it was', async () => {
		const controller = new AbortController();
		const backend = through((env) => {
			const read = env.readTextFile.bind(env);
			env.readTextFile = async (path, signal) => {
				const result = await read(path, signal);
				controller.abort();
				return result;
			};
		});
		const site = openWorkspace({ name: 'cut', backend: { bash: backend } });
		await seed(site, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
		const outcome = call(
			site,
			patchOf(
				'*** Update File: a.txt',
				'-a',
				'+A',
				'*** Delete File: b.txt',
				'*** Add File: c.txt',
				'+c',
			),
			callAs(agent.name, { signal: controller.signal }),
		);
		await expect(outcome).rejects.toThrow('Operation aborted');
		expect(await textOf(site, 'a.txt')).toBe('a\n');
		expect(await existsIn(site, 'b.txt')).toBe(true);
		expect(await existsIn(site, 'c.txt')).toBe(false);
		await site.dispose();
	});

	it('names the file and the code when the port refuses a write', async () => {
		const backend = through((env) => {
			const write = env.writeFile.bind(env);
			env.writeFile = async (path, content, signal) =>
				path.endsWith('/locked.txt')
					? { ok: false, error: new FileError('permission_denied', 'no') }
					: write(path, content, signal);
		});
		const site = openWorkspace({ name: 'refuse', backend: { bash: backend } });
		const outcome = call(
			site,
			patchOf('*** Add File: a.txt', '+a', '*** Add File: locked.txt', '+b'),
		);
		await expect(outcome).rejects.toThrow(
			'Could not apply patch to locked.txt. Error code: permission_denied. Earlier files of the patch may be written.',
		);
		await site.dispose();
	});

	it('names the file and the code when the port refuses a delete', async () => {
		const backend = through((env) => {
			env.remove = async () => ({ ok: false, error: new FileError('permission_denied', 'no') });
		});
		const site = openWorkspace({ name: 'refuse', backend: { bash: backend } });
		await seed(site, { 'a.txt': 'a\n' });
		const outcome = call(site, patchOf('*** Delete File: a.txt'));
		await expect(outcome).rejects.toThrow(
			'Could not apply patch to a.txt. Error code: permission_denied.',
		);
		await site.dispose();
	});

	it('names the port code when the port refuses a read', async () => {
		const backend = through((env) => {
			env.readTextFile = async () => ({
				ok: false,
				error: new FileError('permission_denied', 'no'),
			});
		});
		const site = openWorkspace({ name: 'refuse', backend: { bash: backend } });
		await seed(site, { 'a.txt': 'a\n' });
		const outcome = call(site, patchOf('*** Update File: a.txt', '-a', '+b'));
		await expect(outcome).rejects.toThrow(
			'Could not apply patch to a.txt (Update File): Could not edit file: a.txt. Error code: permission_denied.',
		);
		await site.dispose();
	});
});

describe('the arguments of the apply_patch tool', () => {
	const prepare = (args: unknown) => {
		const site = openWorkspace({ name: 'args', backend: { bash: memoryBackend() } });
		const tool = toolOf(site, 'apply_patch');
		return { site, prepared: tool.prepareArguments?.(args) };
	};

	it.each([
		{ name: 'a bare string', args: 'P', expected: { input: 'P' } },
		{ name: 'the name patch', args: { patch: 'P' }, expected: { input: 'P' } },
		{
			name: 'input beside patch',
			args: { input: 'I', patch: 'P' },
			expected: { input: 'I', patch: 'P' },
		},
		{ name: 'input', args: { input: 'I' }, expected: { input: 'I' } },
		{ name: 'a number', args: 7, expected: 7 },
		{ name: 'null', args: null, expected: null },
	])('prepares $name', async ({ args, expected }) => {
		const { site, prepared } = prepare(args);
		expect(prepared).toEqual(expected);
		await site.dispose();
	});

	it('describes the grammar and states that all changes apply or none', async () => {
		const site = openWorkspace({ name: 'args', backend: { bash: memoryBackend() } });
		const tool = toolOf(site, 'apply_patch');
		expect(tool.description).toContain('All changes apply, or none do.');
		for (const marker of [
			'*** Begin Patch',
			'*** Add File:',
			'*** Delete File:',
			'*** Update File:',
			'*** Move to:',
			'*** End of File',
			'*** End Patch',
		]) {
			expect(tool.description).toContain(marker);
		}
		await site.dispose();
	});
});
