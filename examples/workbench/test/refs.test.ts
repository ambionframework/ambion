import { commitUri, snapshotUri } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { shared } from '../src/definitions.ts';
import { chipLine, type Known, labUri, resolveRef, tableOfUri } from '../src/refs.ts';

const DIGEST = `a1b2c3d4${'0'.repeat(56)}`;
const known: Known = {
	room: 'bringup',
	rooms: ['bringup', 'power'],
	files: ['/library/led-5mm.md', '/shared/my notes.md'],
	tables: ['runs', 'results'],
	seqs: new Set([1, 2, 3]),
};

describe('resolveRef', () => {
	it('resolves a file: URI to a workspace path in the file list', () => {
		const resolved = resolveRef('file:///library/led-5mm.md', known);
		expect(resolved.kind).toBe('file');
		expect(resolved.target).toEqual({ kind: 'file', path: '/library/led-5mm.md' });
	});

	it('decodes the path and drops a fragment or a query', () => {
		expect(resolveRef('file:///shared/my%20notes.md#L3', known).target).toEqual({
			kind: 'file',
			path: '/shared/my notes.md',
		});
		expect(resolveRef('file:///library/led-5mm.md?x=1', known).target?.kind).toBe('file');
	});

	it('marks a file that the workspace does not list', () => {
		const resolved = resolveRef('file:///library/missing.md', known);
		expect(resolved.target).toBeUndefined();
		expect(resolved.problem).toBe('not in the workspace');
	});

	it('refuses a path that leaves the workspace, whatever its encoding', () => {
		const escapes = [
			'file:///../etc/passwd',
			'file:///library/../../etc/passwd',
			'file:///library/%2e%2e/%2e%2e/etc/passwd',
			'file:///library%2F..%2F..%2Fetc%2Fpasswd',
			'file:///library//led-5mm.md',
			'file:///library\\led-5mm.md',
			'file:///library/led%00.md',
			'file:///library/%zz',
		];
		for (const ref of escapes) expect(resolveRef(ref, known).target, ref).toBeUndefined();
	});

	it('refuses a file: URI with a host or a relative form', () => {
		expect(resolveRef('file://host/etc/passwd', known).target).toBeUndefined();
		expect(resolveRef('file:etc/passwd', known).target).toBeUndefined();
		expect(resolveRef('file:///etc/passwd', known).problem).toBe('not in the workspace');
	});

	it('resolves a lab URI to a table, and marks a missing one', () => {
		expect(resolveRef(labUri('runs'), known).target).toEqual({ kind: 'table', name: 'runs' });
		expect(resolveRef('lab:///nothing', known).problem).toBe('no such lab table');
		expect(resolveRef('lab:///runs;drop', known).target).toBeUndefined();
		expect(resolveRef('lab:///', known).target).toBeUndefined();
	});

	it('opens a snapshot of this workspace from its store, labelled with the path it had', () => {
		const ref = snapshotUri('workbench', DIGEST, '/shared/my notes.md');
		expect(resolveRef(ref, known)).toMatchObject({
			kind: 'snapshot',
			label: '/shared/my notes.md @a1b2c3d4',
			target: { kind: 'snapshot', ref, label: '/shared/my notes.md @a1b2c3d4' },
		});
	});

	it('marks a snapshot of another workspace', () => {
		const ref = snapshotUri('elsewhere', DIGEST, '/a.md');
		expect(resolveRef(ref, known)).toMatchObject({
			kind: 'snapshot',
			problem: 'in workspace elsewhere',
		});
		expect(resolveRef(ref, known).target).toBeUndefined();
	});

	it('opens a commit of this workspace, labelled with its repository, its branch, and its short hash', () => {
		const ref = commitUri('workbench', 'bench/firmware', 'e'.repeat(40), { branch: 'blink' });
		expect(resolveRef(ref, known)).toMatchObject({
			kind: 'commit',
			label: 'bench/firmware blink eeeeeee',
			target: { kind: 'commit', ref, label: 'bench/firmware blink eeeeeee' },
		});
		const other = commitUri('elsewhere', 'bench/firmware', 'e'.repeat(40));
		expect(resolveRef(other, known)).toMatchObject({ problem: 'in workspace elsewhere' });
		expect(resolveRef(other, known).target).toBeUndefined();
	});

	it.each([
		['ambion://room/bringup/message/2', { kind: 'message', room: 'bringup', seq: 2 }, '2'],
		['ambion://room/power/message/7', { kind: 'message', room: 'power', seq: 7 }, 'power 7'],
		['ambion://room/power', { kind: 'room', room: 'power' }, 'power'],
		['ambion://room/bringup', { kind: 'room', room: 'bringup' }, 'bringup'],
	])('opens %s', (ref, target, label) => {
		expect(resolveRef(ref, known)).toMatchObject({ target, label });
	});

	it.each([
		['ambion://room/bringup/message/9', 'message 9 is not read yet'],
		['ambion://room/nowhere/message/2', 'no room nowhere'],
		['ambion://room/nowhere', 'no room nowhere'],
	])('marks %s', (ref, problem) => {
		expect(resolveRef(ref, known)).toMatchObject({ problem });
		expect(resolveRef(ref, known).target).toBeUndefined();
	});

	it('marks a scheme it does not know as unknown', () => {
		const resolved = resolveRef('https://example.com/a', known);
		expect(resolved.kind).toBe('unknown');
		expect(resolved.target).toBeUndefined();
	});
});

describe('tableOfUri', () => {
	it('reads a lab URI and no other string', () => {
		expect(tableOfUri('lab:///runs')).toBe('runs');
		expect(tableOfUri('/shared/runs')).toBeUndefined();
		expect(tableOfUri('lab:///a/b')).toBeUndefined();
	});
});

describe('chipLine', () => {
	const file = resolveRef('file:///library/led-5mm.md', known);
	const missing = resolveRef('file:///library/missing-datasheet-with-a-long-name.md', known);

	it('shows a marker, the kind, and the label', () => {
		expect(chipLine(file, 80)).toBe('↗ file  /library/led-5mm.md');
		expect(chipLine(resolveRef('lab:///runs', known), 80)).toBe('↗ table  runs');
		expect(chipLine(resolveRef('ambion://room/bringup/message/2', known), 80)).toBe('↗ message  2');
		expect(chipLine(resolveRef('ambion://room/power', known), 80)).toBe('↗ room  power');
		expect(chipLine(resolveRef(snapshotUri('workbench', DIGEST, '/a.md'), known), 80)).toBe(
			'↗ snapshot  /a.md @a1b2c3d4',
		);
	});

	it('marks a ref that does not resolve, and says why', () => {
		expect(chipLine(resolveRef('gopher://x', known), 80)).toBe(
			'✗ ref  gopher://x  (this scheme opens nothing)',
		);
	});

	it('fits every chip to the width, and keeps the marker and the reason', () => {
		for (const width of [40, 50, 80]) {
			for (const item of [file, missing])
				expect(chipLine(item, width).length).toBeLessThanOrEqual(width);
		}
		const line = chipLine(missing, 50);
		expect(line.startsWith('✗ file  ')).toBe(true);
		expect(line).toContain('…');
		expect(line.endsWith('(not in the workspace)')).toBe(true);
	});
});

describe('the team instructions', () => {
	it('name a file path and a table URI in examples that the terminal resolves', () => {
		expect(shared).toContain('for example /library/led-5mm.md');
		expect(shared).toContain('lab:///<table>, for example lab:///runs');
		expect(known.files).toContain('/library/led-5mm.md');
		expect(resolveRef('lab:///runs', known).target).toBeDefined();
	});
});
