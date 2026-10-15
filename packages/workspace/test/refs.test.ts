/**
 * Snapshot refs and commit refs: the pure rules of the two forms.
 */
import { describe, expect, it } from 'vitest';
import { commitUri, parseCommitUri, parseSnapshotUri, snapshotUri } from '../src/index.ts';

const DIGEST = 'a'.repeat(64);
const SNAPSHOT = `ambion://workspace/lab/snapshot/${DIGEST}`;

describe('snapshot URIs', () => {
	it.each([
		['/home/analyst/report.md', `${SNAPSHOT}/home/analyst/report.md`],
		['/shared/a b/r%.md', `${SNAPSHOT}/shared/a%20b/r%25.md`],
		['/é', `${SNAPSHOT}/%C3%A9`],
	])('round-trips %j', (path, uri) => {
		expect(snapshotUri('lab', DIGEST, path)).toBe(uri);
		expect(parseSnapshotUri(uri)).toEqual({ workspace: 'lab', digest: DIGEST, path });
	});

	it.each([
		`${SNAPSHOT}`,
		`${SNAPSHOT}/`,
		`${SNAPSHOT}/a//b`,
		`${SNAPSHOT}/a/../b`,
		`${SNAPSHOT}/./b`,
		`${SNAPSHOT}/a%2Fb`,
		`${SNAPSHOT}/a%00b`,
		`${SNAPSHOT}/a%0Ab`,
		`${SNAPSHOT}/a%1B%5B31mred`,
		`${SNAPSHOT}/a%7Fb`,
		`${SNAPSHOT}/a%zz`,
		`${SNAPSHOT}/a%2db`,
		`${SNAPSHOT}/a%20`.replace('%20', ' '),
		`ambion://workspace/Lab/snapshot/${DIGEST}/a`,
		`ambion://workspace/lab/snapshot/${'A'.repeat(64)}/a`,
		`ambion://workspace/lab/snapshot/${'a'.repeat(63)}/a`,
		`ambion://workspace/lab/file/${DIGEST}/a`,
	])('refuses %s', (uri) => {
		expect(parseSnapshotUri(uri)).toBeUndefined();
	});

	it.each([
		['Lab', DIGEST, '/a'],
		['lab', 'abc', '/a'],
		['lab', DIGEST, 'a'],
		['lab', DIGEST, '/a/'],
		['lab', DIGEST, '/a/../b'],
		['lab', DIGEST, '/a\nb'],
		['lab', DIGEST, '/a\u001b[2Jb'],
	])('refuses to build %s %s %s', (workspace, digest, path) => {
		expect(() => snapshotUri(workspace, digest, path)).toThrow(RangeError);
	});
});

const SHA = 'c'.repeat(40);
const REPO = 'ambion://workspace/lab/repo/analyst/site';

describe('commit URIs', () => {
	it.each([
		[undefined, `${REPO}/commit/${SHA}`],
		[{ branch: 'main' }, `${REPO}/branch/main/commit/${SHA}`],
		[{ branch: 'feature/pour' }, `${REPO}/branch/feature%2Fpour/commit/${SHA}`],
		[{ tag: 'v1.0' }, `${REPO}/tag/v1.0/commit/${SHA}`],
	])('round-trips a commit named by %j', (via, uri) => {
		expect(commitUri('lab', 'analyst/site', SHA, via)).toBe(uri);
		expect(parseCommitUri(uri)).toEqual({
			workspace: 'lab',
			repository: 'analyst/site',
			commit: SHA,
			...via,
		});
	});

	it('takes a SHA-256 hash of 64 digits', () => {
		const sha256 = 'd'.repeat(64);
		expect(parseCommitUri(`${REPO}/commit/${sha256}`)?.commit).toBe(sha256);
	});

	it.each([
		`${REPO}/commit/${'c'.repeat(7)}`,
		`${REPO}/commit/${'C'.repeat(40)}`,
		`${REPO}/commit/${'c'.repeat(41)}`,
		`${REPO}/branch/commit/${SHA}`,
		`${REPO}/branch/feature/pour/commit/${SHA}`,
		`${REPO}/branch/%2e%2e/commit/${SHA}`,
		`${REPO}/branch/ma%69n/commit/${SHA}`,
		`${REPO}/branch/a%zz/commit/${SHA}`,
		`${REPO}/branch/x%1B%5B2J/commit/${SHA}`,
		`${REPO}/tag/v%0A1/commit/${SHA}`,
		`${REPO}/head/main/commit/${SHA}`,
		`ambion://workspace/lab/repo/site/commit/${SHA}`,
		`ambion://workspace/lab/repo/analyst%2Fx/site/commit/${SHA}`,
		`ambion://workspace/Lab/repo/analyst/site/commit/${SHA}`,
	])('refuses %s', (uri) => {
		expect(parseCommitUri(uri)).toBeUndefined();
	});

	it.each([
		['Lab', 'analyst/site', SHA, undefined],
		['lab', 'site', SHA, undefined],
		['lab', 'a/b/c', SHA, undefined],
		['lab', 'analyst/..', SHA, undefined],
		['lab', 'analyst/site', 'abc1234', undefined],
		['lab', 'analyst/site', SHA, { branch: '' }],
		['lab', 'analyst/site', SHA, { tag: '..' }],
	])('refuses to build %s %s %s %j', (workspace, repository, commit, via) => {
		expect(() => commitUri(workspace, repository, commit, via)).toThrow(RangeError);
	});
});
