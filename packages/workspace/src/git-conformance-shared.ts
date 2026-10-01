/** Conformance cases for shared repositories: writable by every agent, with main protected. */

import { check } from '@ambionframework/ambion/conformance';
import type { GitBackend } from './git-backend.ts';
import type { GitConformanceOptions, GitConformanceStore } from './git-conformance.ts';
import { ANALYST, forkAs, git, REVIEWER, sh } from './git-conformance-support.ts';
import { openWorkspace, type Workspace } from './workspace.ts';

/** The shared repository seeded for each ordinary conformance case. */
export const SHARED_FIXTURE: NonNullable<GitConformanceOptions['shared']> = {
	'room-notes': { source: { 'README.md': 'shared notes\n' }, description: 'Notes for the room.' },
	empty: { source: {}, description: 'An intentionally empty shared repository.' },
};

/** Both agents may push, but a stale main push must be rebased before it lands. */
export async function sharedPushesMergeFromBothAgents(workspace: Workspace): Promise<void> {
	const repo = await git(workspace, ANALYST, (env) => env.get('shared/room-notes'));
	check(repo !== undefined, 'the shared repository is missing');
	if (repo === undefined) return;
	const first = await sh(
		workspace,
		ANALYST,
		`git clone ${repo.url} ~/shared-first && cd ~/shared-first`,
	);
	check(first.code === 0, `the first shared clone failed: ${first.output}`);
	const secondClone = await sh(workspace, REVIEWER, `git clone ${repo.url} ~/shared-second`);
	check(secondClone.code === 0, `the second shared clone failed: ${secondClone.output}`);
	const firstCommit = await sh(
		workspace,
		ANALYST,
		'cd ~/shared-first && echo analyst > analyst.txt && git add analyst.txt && git commit -m analyst && git push origin main',
	);
	check(firstCommit.code === 0, `the first shared push failed: ${firstCommit.output}`);
	const secondCommit = await sh(
		workspace,
		REVIEWER,
		'cd ~/shared-second && echo reviewer > reviewer.txt && git add reviewer.txt && git commit -m reviewer',
	);
	check(secondCommit.code === 0, `the second shared commit failed: ${secondCommit.output}`);
	const refused = await sh(workspace, REVIEWER, 'cd ~/shared-second && git push origin main');
	check(refused.code !== 0, 'a stale shared main push was accepted');
	const rebased = await sh(
		workspace,
		REVIEWER,
		'cd ~/shared-second && git pull --rebase origin main && git push origin main',
	);
	check(rebased.code === 0, `the rebased shared push failed: ${rebased.output}`);
	const verify = await sh(
		workspace,
		ANALYST,
		`git clone ${repo.url} ~/shared-check && cd ~/shared-check && cat analyst.txt reviewer.txt`,
	);
	check(
		verify.code === 0 && verify.output.includes('analyst') && verify.output.includes('reviewer'),
		`rebasing did not preserve both agents' commits: ${verify.output}`,
	);
}

/** Main rejects deletion and non-fast-forward updates; side branches remain mutable. */
export async function sharedMainAndSideBranchPolicy(workspace: Workspace): Promise<void> {
	const repo = await git(workspace, ANALYST, (env) => env.get('shared/room-notes'));
	check(repo !== undefined, 'the shared repository is missing');
	if (repo === undefined) return;
	const mainWriter = await sh(workspace, ANALYST, `git clone ${repo.url} ~/shared-main-writer`);
	check(mainWriter.code === 0, `the main writer clone failed: ${mainWriter.output}`);
	const clone = await sh(workspace, REVIEWER, `git clone ${repo.url} ~/shared-policy`);
	check(clone.code === 0, `the shared clone failed: ${clone.output}`);
	const acceptedMain = await sh(
		workspace,
		ANALYST,
		'cd ~/shared-main-writer && echo accepted > accepted.txt && git add accepted.txt && git commit -m accepted && git push origin main',
	);
	check(
		acceptedMain.code === 0,
		`a fast-forward shared main push was refused: ${acceptedMain.output}`,
	);
	const divergent = await sh(
		workspace,
		REVIEWER,
		'cd ~/shared-policy && echo divergent > divergent.txt && git add divergent.txt && git commit -m divergent && git push --force origin main',
	);
	check(divergent.code !== 0, 'a non-fast-forward update to shared main was accepted');
	const deletedMain = await sh(
		workspace,
		REVIEWER,
		'cd ~/shared-policy && git push --delete origin main',
	);
	check(deletedMain.code !== 0, 'deleting shared main was accepted');
	const side = await sh(
		workspace,
		REVIEWER,
		'cd ~/shared-policy && git switch -c scratch && echo one > scratch.txt && git add scratch.txt && git commit -m scratch && git push origin scratch',
	);
	check(side.code === 0, `creating a shared side branch failed: ${side.output}`);
	const peerRead = await sh(
		workspace,
		ANALYST,
		'cd ~/shared-main-writer && git fetch origin scratch && git show origin/scratch:scratch.txt',
	);
	check(
		peerRead.code === 0 && peerRead.output.includes('one'),
		`a peer could not read the side branch: ${peerRead.output}`,
	);
	const sideRewrite = await sh(
		workspace,
		REVIEWER,
		'cd ~/shared-policy && echo two > scratch.txt && git commit -am rewrite && git push origin scratch && git reset --hard HEAD~1 && git push --force origin scratch && git push --delete origin scratch',
	);
	check(
		sideRewrite.code === 0,
		`rewriting or deleting a shared side branch failed: ${sideRewrite.output}`,
	);
	const forkUrl = await forkAs(workspace, ANALYST, 'shared/room-notes', 'policy-fork');
	const forkPolicy = await sh(
		workspace,
		ANALYST,
		`git clone ${forkUrl} ~/policy-fork && cd ~/policy-fork && echo fork > fork.txt && git add fork.txt && git commit -m fork && git push origin main && git reset --hard HEAD~1 && git push --force origin main`,
	);
	check(forkPolicy.code === 0, `a fork inherited shared main protection: ${forkPolicy.output}`);
}

/** A fork of shared main has ordinary fork permissions and supports ref citations. */
export async function sharedForkAndRefsRoundTrip(workspace: Workspace): Promise<void> {
	const shared = await git(workspace, ANALYST, (env) => env.get('shared/room-notes'));
	check(shared !== undefined, 'the shared repository is missing');
	if (shared === undefined) return;
	const fork = await git(workspace, ANALYST, (env) => env.fork('shared/room-notes', 'roundtrip'));
	check(fork.ok, `forking the shared repository failed: ${fork.ok ? '' : fork.reason}`);
	if (!fork.ok) return;
	const pushed = await sh(
		workspace,
		ANALYST,
		`git clone ${fork.repository.url} ~/shared-fork && cd ~/shared-fork && echo citation > citation.txt && git add citation.txt && git commit -m citation && git push origin main && git rev-parse HEAD`,
	);
	check(pushed.code === 0, `a normal fork push failed: ${pushed.output}`);
	const head = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/m.exec(pushed.output)?.[0];
	check(head !== undefined, `the shared fork gave no commit hash: ${pushed.output}`);
	if (head === undefined) return;
	const resolved = await git(workspace, REVIEWER, (env) =>
		env.resolve('analyst/roundtrip', { branch: 'main' }),
	);
	check(resolved === head, `the shared fork ref resolved to ${resolved}`);
	const sharedTip = await git(workspace, REVIEWER, (env) =>
		env.resolve('shared/room-notes', { branch: 'main' }),
	);
	check(typeof sharedTip === 'string', 'the shared main ref did not resolve');
	const sharedUri = await workspace.commitRef('shared/room-notes', { branch: 'main' });
	const sharedRead = await workspace.readCommit(sharedUri);
	check(sharedRead.hash === sharedTip, `the shared commit URI roundtrip gave ${sharedRead.hash}`);
	const uri = await workspace.commitRef('analyst/roundtrip', { branch: 'main' });
	const read = await workspace.readCommit(uri);
	check(read.hash === head, `the shared fork commit URI roundtrip gave ${read.hash}`);
}

/** Two concurrent pushes from the same base cannot both move shared main. */
export async function concurrentSharedMainPushes(workspace: Workspace): Promise<void> {
	const repo = await git(workspace, ANALYST, (env) => env.get('shared/room-notes'));
	check(repo !== undefined, 'the shared repository is missing');
	if (repo === undefined) return;
	const analystClone = await sh(workspace, ANALYST, `git clone ${repo.url} ~/race-analyst`);
	const reviewerClone = await sh(workspace, REVIEWER, `git clone ${repo.url} ~/race-reviewer`);
	check(analystClone.code === 0, `analyst clone failed: ${analystClone.output}`);
	check(reviewerClone.code === 0, `reviewer clone failed: ${reviewerClone.output}`);
	const analystCommit = await sh(
		workspace,
		ANALYST,
		'cd ~/race-analyst && echo analyst > race-analyst.txt && git add race-analyst.txt && git commit -m analyst',
	);
	const reviewerCommit = await sh(
		workspace,
		REVIEWER,
		'cd ~/race-reviewer && echo reviewer > race-reviewer.txt && git add race-reviewer.txt && git commit -m reviewer',
	);
	check(analystCommit.code === 0, `analyst commit failed: ${analystCommit.output}`);
	check(reviewerCommit.code === 0, `reviewer commit failed: ${reviewerCommit.output}`);
	const pushes = await Promise.all([
		sh(workspace, ANALYST, 'cd ~/race-analyst && git push origin main'),
		sh(workspace, REVIEWER, 'cd ~/race-reviewer && git push origin main'),
	]);
	check(
		pushes.filter((push) => push.code === 0).length === 1,
		`same-base shared pushes should have one winner and one rejection: ${JSON.stringify(pushes)}`,
	);
	const head = await git(workspace, REVIEWER, (env) =>
		env.resolve('shared/room-notes', { branch: 'main' }),
	);
	check(typeof head === 'string', 'the winning concurrent push left no shared main tip');
	if (head === undefined) return;
	const shown = await git(workspace, REVIEWER, (env) => env.show('shared/room-notes', head));
	const paths = shown?.changes.map((change) => change.path) ?? [];
	check(
		paths.includes('race-analyst.txt') !== paths.includes('race-reviewer.txt'),
		`the shared main tip does not identify exactly one winning push: ${paths}`,
	);
}

/** Guidance identifies shared repositories and tells agents how to handle shared main. */
export async function sharedGuidanceExplainsPushPolicy(workspace: Workspace): Promise<void> {
	const guidance = workspace.tools().guidance ?? '';
	check(guidance.includes('shared/<name>'), 'git guidance does not describe shared repositories');
	check(guidance.includes('origin/main'), 'git guidance does not explain the shared main policy');
}

/** Reopening registration keeps a shared repository and does not re-read a changed or broken source. */
export async function sharedRegistrationPersists<B extends GitBackend>(
	store: GitConformanceStore<B>,
	fixture: NonNullable<GitConformanceOptions['shared']>,
): Promise<void> {
	const open = async (options: GitConformanceOptions) => {
		const borrowedBash = new Proxy(store.bash, {
			get(target, property, receiver) {
				if (property === 'dispose') return async () => {};
				return Reflect.get(target, property, receiver);
			},
		});
		return openWorkspace({
			name: 'git-conformance',
			backend: { bash: borrowedBash, git: store.backend(options) },
		});
	};
	const first = await open({ templates: {}, shared: fixture });
	let initial: string | undefined;
	let url = '';
	try {
		const repo = await git(first, ANALYST, (env) => env.get('shared/room-notes'));
		initial = repo?.branches.main;
		url = repo?.url ?? '';
		check(initial !== undefined, 'the first shared registration made no main commit');
		check(repo?.description === 'Notes for the room.', 'the shared description was lost');
		const empty = await git(first, ANALYST, (env) => env.get('shared/empty'));
		check(
			typeof empty?.branches.main === 'string' && empty.branches.main.length >= 40,
			'an empty shared source did not get a real initial main commit',
		);
		const seeded = await git(first, ANALYST, (env) => env.show('shared/room-notes', initial ?? ''));
		check(seeded?.author.name === 'ambion', 'the initial shared commit was not seeded by ambion');
	} finally {
		await first.dispose();
	}
	const changed = await open({
		templates: {},
		shared: {
			'room-notes': {
				source: { 'README.md': 'changed source\n', 'new.md': 'new source\n' },
				description: 'Updated description.',
			},
		},
	});
	try {
		const repo = await git(changed, REVIEWER, (env) => env.get('shared/room-notes'));
		check(
			repo?.branches.main === initial,
			'a restarted registration changed shared main from its new source',
		);
		check(
			repo?.description === 'Updated description.',
			'a restarted registration did not update description',
		);
	} finally {
		await changed.dispose();
	}
	const unreadable = await open({
		templates: {},
		shared: {
			'room-notes': {
				source: {
					read: async () => {
						throw new Error('existing shared source was read');
					},
				},
				description: 'Description without reading source.',
			},
		},
	});
	try {
		const repo = await git(unreadable, ANALYST, (env) => env.get('shared/room-notes'));
		check(repo?.branches.main === initial, 'an unreadable source changed shared main');
		check(
			repo?.description === 'Description without reading source.',
			'an unreadable source blocked a description update',
		);
	} finally {
		await unreadable.dispose();
	}
	const omitted = await open({ templates: {} });
	let pushedHead: string | undefined;
	try {
		const repo = await git(omitted, REVIEWER, (env) => env.get('shared/room-notes'));
		check(repo?.branches.main === initial, 'omitting shared registration removed the repository');
		const pushed = await sh(
			omitted,
			REVIEWER,
			`git clone ${url} ~/omitted-shared && cd ~/omitted-shared && echo persisted > persisted.txt && git add persisted.txt && git commit -m persisted && git push origin main`,
		);
		check(pushed.code === 0, `an omitted shared registration was not writable: ${pushed.output}`);
		pushedHead = (await git(omitted, REVIEWER, (env) => env.get('shared/room-notes')))?.branches
			.main;
		check(
			typeof pushedHead === 'string' && pushedHead !== initial,
			'the omitted shared push did not move main',
		);
	} finally {
		await omitted.dispose();
	}
	const afterPushRestart = await open({
		templates: {},
		shared: {
			'room-notes': {
				source: {
					read: async () => {
						throw new Error('a restart read the already-published shared source');
					},
				},
				description: 'Description without reading source.',
			},
		},
	});
	try {
		const repo = await git(afterPushRestart, ANALYST, (env) => env.get('shared/room-notes'));
		check(
			repo?.branches.main === pushedHead,
			'a restart replaced an agent push with the registered seed',
		);
	} finally {
		await afterPushRestart.dispose();
	}
}
