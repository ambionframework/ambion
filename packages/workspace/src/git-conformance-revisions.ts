/**
 * The git conformance cases of revisions: `resolve` of a branch, a tag, and
 * a hash, `show` of one commit, and the workspace's `commitRef` and
 * `readCommit` over them.
 */

import { commitUri } from '@ambionframework/ambion';
import { check } from '@ambionframework/ambion/conformance';
import type { GitRevision } from './git-backend.ts';
import { ANALYST, forkAs, git, REVIEWER, sh } from './git-conformance-support.ts';
import type { Workspace } from './workspace.ts';

/** The SHA-1 blobs of `collide 826\n` and `collide 4561\n` both start with it. */
const COLLIDING_PREFIX = 'b2664c8';

/**
 * Push a branch, an annotated tag, and a lightweight tag to a fork, then
 * resolve each one, a short and a full hash, and names that do not exist.
 * A short hash names its commit when a branch has the same name, and a
 * prefix of two objects names none.
 */
export async function resolvesBranchTagAndHash({
	workspace,
}: {
	workspace: Workspace;
}): Promise<void> {
	const url = await forkAs(workspace, ANALYST, 'templates/weekly-report', 'report');
	const pushed = await sh(
		workspace,
		ANALYST,
		`git clone ${url} ~/report && cd ~/report && git switch -c week-40 && echo 40 > answer.txt && git add answer.txt && git commit -m "Week 40" && git tag -a v40 -m "Week 40" && git tag light && git push origin week-40 v40 light`,
	);
	check(pushed.code === 0, `the push of a branch and two tags failed: ${pushed.output}`);
	const parsed = await sh(workspace, ANALYST, 'cd ~/report && git rev-parse HEAD');
	const head = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/m.exec(parsed.output)?.[0] ?? '';
	check(head !== '', `git rev-parse gave no hash: ${parsed.output}`);
	// A branch named like the short hash, and two blobs whose hashes share a prefix.
	const short = head.slice(0, 7);
	const odd = await sh(
		workspace,
		ANALYST,
		`cd ~/report && git push origin main:refs/heads/${short} && git switch -c collide && echo 'collide 826' > a.txt && echo 'collide 4561' > b.txt && git add a.txt b.txt && git commit -m "Collide" && git push origin collide && git switch week-40`,
	);
	check(odd.code === 0, `the push of a hash-named branch and two blobs failed: ${odd.output}`);
	const template = await git(workspace, REVIEWER, (env) => env.get('templates/weekly-report'));
	const found: [GitRevision, string | undefined][] = [
		[{ branch: 'week-40' }, head],
		[{ tag: 'v40' }, head],
		[{ tag: 'light' }, head],
		[{ commit: head.slice(0, 7) }, head],
		[{ commit: head }, head],
		[{ branch: 'none' }, undefined],
		[{ tag: 'none' }, undefined],
		[{ commit: '0000000' }, undefined],
		[{ branch: short }, template?.branches.main],
		[{ commit: COLLIDING_PREFIX }, undefined],
	];
	for (const [at, expected] of found) {
		const got = await git(workspace, REVIEWER, (env) => env.resolve('analyst/report', at));
		check(got === expected, `resolve ${JSON.stringify(at)} gave ${got}, not ${expected}`);
	}
	const none = await git(workspace, REVIEWER, (env) =>
		env.resolve('analyst/none', { branch: 'main' }),
	);
	check(none === undefined, 'resolve reached analyst/none');
	const refused = await git(workspace, REVIEWER, (env) =>
		env.resolve('analyst/report', { branch: 'main~1' }),
	).then(
		() => false,
		() => true,
	);
	check(refused, 'resolve read the expression main~1 as a branch');
	const ref = await workspace.commitRef('analyst/report', { tag: 'v40' });
	check(
		ref === commitUri(workspace.name, 'analyst/report', head, { tag: 'v40' }),
		`commitRef gave ${ref}`,
	);
	await showsTheCommit(workspace, head);
	await showsAMerge(workspace, head);
}

/**
 * `show` gives the message, the author, the parent, and the changes of the
 * commit the case pushed, and nothing for a commit or a repository that the
 * server does not hold. `readCommit` gives the same commit for its ref.
 */
async function showsTheCommit(workspace: Workspace, head: string): Promise<void> {
	const template = await git(workspace, REVIEWER, (env) => env.get('templates/weekly-report'));
	const shown = await git(workspace, REVIEWER, (env) => env.show('analyst/report', head));
	check(shown?.hash === head, `show gave ${shown?.hash}, not ${head}`);
	check(shown?.message === 'Week 40\n', `show gave the message ${JSON.stringify(shown?.message)}`);
	check(shown?.author.name === 'analyst', `show gave the author ${shown?.author.name}`);
	check(!Number.isNaN(Date.parse(shown?.author.date ?? '')), 'show gave no author date');
	check(
		JSON.stringify(shown?.parents) === JSON.stringify([template?.branches.main]),
		`show gave the parents ${shown?.parents}`,
	);
	check(
		JSON.stringify(shown?.changes) === JSON.stringify([{ path: 'answer.txt', change: 'added' }]),
		`show gave the changes ${JSON.stringify(shown?.changes)}`,
	);
	const root = await git(workspace, REVIEWER, (env) =>
		env.show('templates/weekly-report', template?.branches.main ?? ''),
	);
	const added = root?.changes ?? [];
	check(
		added.some((entry) => entry.path === 'report.md') &&
			added.every((entry) => entry.change === 'added'),
		`show of a root commit gave the changes ${JSON.stringify(root?.changes)}`,
	);
	const none = await git(workspace, REVIEWER, (env) => env.show('analyst/report', '0'.repeat(40)));
	check(none === undefined, 'show reached a commit that the server does not hold');
	const read = await workspace.readCommit(commitUri(workspace.name, 'analyst/report', head));
	check(read.hash === head, 'readCommit did not give the commit of its ref');
}

/**
 * A merge commit lists its changes against its first parent, on every
 * backend, and names both parents in order.
 */
async function showsAMerge(workspace: Workspace, head: string): Promise<void> {
	const merged = await sh(
		workspace,
		ANALYST,
		'cd ~/report && git switch -c merged main && echo notes > notes.txt && git add notes.txt && git commit -m "Notes" && git merge --no-ff week-40 -m "Merge week 40" && git push origin merged',
	);
	check(merged.code === 0, `the push of a merge failed: ${merged.output}`);
	const tip = await git(workspace, REVIEWER, (env) =>
		env.resolve('analyst/report', { branch: 'merged' }),
	);
	const shown = await git(workspace, REVIEWER, (env) => env.show('analyst/report', tip ?? ''));
	check(
		shown?.parents.length === 2 && shown.parents[1] === head,
		`show of a merge gave the parents ${shown?.parents}`,
	);
	check(
		JSON.stringify(shown?.changes) === JSON.stringify([{ path: 'answer.txt', change: 'added' }]),
		`show of a merge gave the changes ${JSON.stringify(shown?.changes)}`,
	);
}
