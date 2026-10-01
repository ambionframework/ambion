/**
 * The cases every git backend (`GitBackend`) must pass, together with a
 * bash backend whose `git` reaches it.
 *
 * A fixture opens a store: a factory that opens a git backend over the same
 * repositories each time it is called, and a factory that opens a bash
 * backend for one git backend. A case opens a workspace over the bash
 * backend, drives it as agents through `use` and through `git` in the
 * shell, and checks what the contract states. A refused push
 * is checked by the exit status of `git push`: the text of a refusal
 * differs from one backend to the other.
 *
 * The suite knows no access type. Three cases touch a credential, and each
 * asks a hook of the fixture for the fact it checks. The package that
 * pairs the git backend with its bash backend implements the hooks.
 *
 * ```ts
 * describe.each(fixtures)('$name', (fixture) => {
 * 	for (const c of gitConformance(fixture)) it(c.name, c.run);
 * });
 * ```
 */

import {
	type ConformanceCase,
	type ConformanceFixture,
	check,
	conformanceSuite,
} from '@ambionframework/ambion/conformance';
import type { BashBackend } from './backend.ts';
import type { GitBackend } from './git-backend.ts';
import { resolvesBranchTagAndHash } from './git-conformance-revisions.ts';
import {
	concurrentSharedMainPushes,
	SHARED_FIXTURE,
	sharedForkAndRefsRoundTrip,
	sharedGuidanceExplainsPushPolicy,
	sharedMainAndSideBranchPolicy,
	sharedPushesMergeFromBothAgents,
	sharedRegistrationPersists,
} from './git-conformance-shared.ts';
import { ANALYST, ctx, forkAs, git, REVIEWER, sh } from './git-conformance-support.ts';
import type { WorkspaceAgent } from './resource.ts';
import type { SourceInput } from './sources.ts';
import { openWorkspace, type Workspace } from './workspace.ts';

/** One template, as a case registers it. */
export interface GitConformanceTemplate {
	readonly description?: string;
	readonly files: Readonly<Record<string, string>>;
}

/** What a case asks of a git backend. */
export interface GitConformanceOptions {
	readonly templates: Readonly<Record<string, GitConformanceTemplate>>;
	/** Shared repositories, seeded once and then writable by every agent. */
	readonly shared?: Readonly<Record<string, GitConformanceShared>>;
	/** Seconds a credential lives. */
	readonly credentialTtl?: number;
}

/** One shared repository registration, including a source that can detect unwanted reads. */
export interface GitConformanceShared {
	readonly source: SourceInput;
	readonly description?: string;
}

/** One store of repositories, and the bash backend that reaches it. */
export interface GitConformanceStore<B extends GitBackend = GitBackend> {
	/** Open a bash backend whose `git` is `git`. The workspace that holds it disposes it. */
	bash(git: B): BashBackend;
	/** Open a git backend over this store's repositories. */
	backend(options: GitConformanceOptions): B;
	dispose(): Promise<void>;
}

/** The git backend that a case opened, and the workspace over it. */
export interface GitConformancePair<B extends GitBackend = GitBackend> {
	readonly backend: B;
	readonly workspace: Workspace;
}

/** One credential under test: when it expires, and whether the server accepts it now. */
export interface GitConformanceProbe {
	/** Milliseconds since the epoch. */
	readonly expiresAt: number;
	/** Resolves `true` when the server accepts the credential, and `false` when it refuses it. */
	accepted(): Promise<boolean>;
}

/**
 * A git backend under test. `open` runs inside every case. The three hooks
 * answer the credential facts of the pair, each over the backend and the
 * workspace that the case opened.
 */
export interface GitConformanceBackend<
	B extends GitBackend = GitBackend,
> extends ConformanceFixture<GitConformanceStore<B>> {
	readonly name: string;
	/** The shortest `credentialTtl`, in seconds, that the backend takes. */
	readonly shortestCredentialTtl: number;
	/** Issue the credentials of `agent`, the way its bash backend asks for them. Rejects for a reserved name. */
	issueCredentials(pair: GitConformancePair<B>, agent: WorkspaceAgent): Promise<void>;
	/** Resolves `true` when `agent` holds a write credential for the repository at `url`. */
	writeCredential(
		pair: GitConformancePair<B>,
		agent: WorkspaceAgent,
		url: string,
	): Promise<boolean>;
	/** A read credential of `agent` for `templates/blank`, with the shortest life the case asked for. */
	probeCredential(pair: GitConformancePair<B>, agent: WorkspaceAgent): Promise<GitConformanceProbe>;
}

const TEMPLATES: GitConformanceOptions['templates'] = {
	'weekly-report': {
		description: 'A weekly status report.',
		files: { 'report.md': '# Week\n', 'data/numbers.csv': 'a,b\n1,2\n', '.gitignore': 'data/\n' },
	},
	blank: { files: { 'README.md': 'blank\n' } },
};

/** One case: the pair it opened, and the fixture that answers the credential facts. */
type Body = <B extends GitBackend>(
	pair: GitConformancePair<B>,
	fixture: GitConformanceBackend<B>,
) => Promise<void>;

/** Run `body` over a workspace on `store`, and dispose the workspace after. */
async function withWorkspace<B extends GitBackend>(
	fixture: GitConformanceBackend<B>,
	store: GitConformanceStore<B>,
	body: Body,
	options: GitConformanceOptions = { templates: TEMPLATES, shared: SHARED_FIXTURE },
): Promise<void> {
	const backend = store.backend(options);
	const workspace = openWorkspace({
		name: 'git-conformance',
		backend: { bash: store.bash(backend) },
	});
	try {
		await body({ backend, workspace }, fixture);
	} finally {
		await workspace.dispose();
	}
}

// -- the cases ----------------------------------------------------------------

const listsTemplatesAndForks: Body = async ({ workspace }) => {
	await forkAs(workspace, ANALYST, 'templates/weekly-report', 'report');
	const all = await git(workspace, ANALYST, (env) => env.list());
	const ids = all.map((repository) => repository.id);
	check(
		JSON.stringify(ids) ===
			JSON.stringify([
				'analyst/report',
				'shared/empty',
				'shared/room-notes',
				'templates/blank',
				'templates/weekly-report',
			]),
		`list gave ${JSON.stringify(ids)}`,
	);
	const template = all.find((repository) => repository.id === 'templates/weekly-report');
	check(template?.description === 'A weekly status report.', 'the template lost its description');
	const fork = all.find((repository) => repository.id === 'analyst/report');
	check(fork?.source === 'templates/weekly-report', 'the fork does not name its source');
	check(fork?.defaultBranch === 'main', 'the fork has no default branch main');
	check(typeof fork?.branches.main === 'string', 'the fork has no main branch');
	check(fork?.branches.main === template?.branches.main, 'the fork does not start at its template');
	check(fork?.url.includes('report') === true, 'the fork has no clone URL');
	const templates = await git(workspace, ANALYST, (env) => env.list('templates'));
	check(templates.length === 2, 'list with a namespace did not keep that namespace alone');
	const shared = await git(workspace, ANALYST, (env) => env.list('shared'));
	check(shared.length === 2, 'list with the shared namespace did not keep that namespace alone');
	const empty = shared.find((repository) => repository.id === 'shared/empty');
	check(
		typeof empty?.branches.main === 'string',
		'an empty shared source did not get a main commit',
	);
};

const cloneSetsOrigin: Body = async ({ workspace }) => {
	const url = await forkAs(workspace, ANALYST, 'templates/weekly-report', 'report');
	const clone = await sh(workspace, ANALYST, `git clone ${url} ~/report`);
	check(clone.code === 0, `the clone failed: ${clone.output}`);
	const read = await workspace.use(ANALYST, (env) => env.readTextFile('~/report/report.md', ctx));
	check(read.ok && read.value === '# Week\n', 'the clone lacks the template file');
	const origin = await sh(workspace, ANALYST, 'cd ~/report && git remote -v');
	check(origin.output.includes(url), `origin is not the fork: ${origin.output}`);
};

const takenNameCreatesNothing: Body = async ({ workspace }) => {
	await forkAs(workspace, ANALYST, 'templates/weekly-report', 'report');
	const before = await git(workspace, ANALYST, (env) => env.list());
	const again = await git(workspace, ANALYST, (env) => env.fork('templates/blank', 'report'));
	check(!again.ok && again.reason === 'name_taken', 'a taken name was not name_taken');
	if (!again.ok && again.reason === 'name_taken') {
		check(again.repository.source === 'templates/weekly-report', 'name_taken gave another fork');
	}
	const after = await git(workspace, ANALYST, (env) => env.list());
	check(after.length === before.length, 'a refused fork created a repository');
};

const missingSourceIsRefused: Body = async ({ workspace }) => {
	const missing = await git(workspace, ANALYST, (env) => env.fork('templates/none', 'x'));
	check(!missing.ok && missing.reason === 'no_source', 'a missing source was not no_source');
};

const forkOfForkNamesItsSource: Body = async ({ workspace }) => {
	await forkAs(workspace, ANALYST, 'templates/weekly-report', 'report');
	await forkAs(workspace, REVIEWER, 'analyst/report', 'review');
	const review = await git(workspace, REVIEWER, (env) => env.get('reviewer/review'));
	check(review?.source === 'analyst/report', 'a fork of a fork does not name its direct source');
};

const reservedNamespaceIsRefused: Body = async (pair, fixture) => {
	const { workspace } = pair;
	for (const name of ['templates', 'shared']) {
		const refused = await git(workspace, { name }, (env) => env.list()).then(
			() => false,
			() => true,
		);
		check(refused, `an agent named ${name} was not refused`);
		const credential = await fixture.issueCredentials(pair, { name }).then(
			() => false,
			() => true,
		);
		check(credential, `an agent named ${name} got a credential`);
	}
};

const ownerPushesPeerReads: Body = async ({ workspace }) => {
	const url = await forkAs(workspace, ANALYST, 'templates/weekly-report', 'report');
	const pushed = await sh(
		workspace,
		ANALYST,
		`git clone ${url} ~/report && cd ~/report && git switch -c week-39 && echo 42 > answer.txt && git add answer.txt && git commit -m "Week 39" && git push origin week-39`,
	);
	check(pushed.code === 0, `the owner's push failed: ${pushed.output}`);
	const read = await sh(
		workspace,
		REVIEWER,
		`git clone ${url} ~/peer && cd ~/peer && git checkout week-39 && cat answer.txt`,
	);
	check(
		read.code === 0 && read.output.includes('42'),
		`a peer did not read the pushed branch: ${read.output}`,
	);
};

/** Clone `url` into `dir` as `agent`, commit one file, and give the exit status of the push. */
async function pushAs(
	workspace: Workspace,
	agent: WorkspaceAgent,
	url: string,
	dir: string,
): Promise<number> {
	const clone = await sh(workspace, agent, `git clone ${url} ${dir}`);
	check(clone.code === 0, `the clone of ${url} failed: ${clone.output}`);
	const commit = await sh(
		workspace,
		agent,
		`cd ${dir} && echo x > x.txt && git add x.txt && git commit -m x`,
	);
	check(commit.code === 0, `the commit failed: ${commit.output}`);
	return (await sh(workspace, agent, `cd ${dir} && git push origin main`)).code;
}

const pushesOutsideTheNamespaceAreRefused: Body = async ({ workspace }) => {
	const template = await git(workspace, ANALYST, (env) => env.get('templates/blank'));
	check(template !== undefined, 'the template is missing');
	if (template === undefined) return;
	check(
		(await pushAs(workspace, ANALYST, template.url, '~/blank')) !== 0,
		'a push to a template was accepted',
	);
	const url = await forkAs(workspace, ANALYST, 'templates/blank', 'mine');
	check(
		(await pushAs(workspace, REVIEWER, url, '~/theirs')) !== 0,
		"a push to another agent's fork was accepted",
	);
	const after = await git(workspace, ANALYST, (env) => env.get('analyst/mine'));
	check(after?.branches.main === template.branches.main, "a refused push moved the fork's main");
	check((await pushAs(workspace, ANALYST, url, '~/mine')) === 0, "the owner's push was refused");
};

const concurrentForksKeepOneFork: Body = async (pair, fixture) => {
	const { backend, workspace } = pair;
	const first = await backend.connect(ANALYST);
	const second = await backend.connect(ANALYST);
	try {
		const outcomes = await Promise.all([
			first.fork('templates/blank', 'twin'),
			second.fork('templates/blank', 'twin'),
		]);
		const kinds = outcomes.map((outcome) => (outcome.ok ? 'ok' : outcome.reason)).sort();
		check(JSON.stringify(kinds) === '["name_taken","ok"]', `two forks of one name gave ${kinds}`);
	} finally {
		await first.cleanup();
		await second.cleanup();
	}
	// A bash backend asks for the credentials of an agent beside the forks of other agents.
	let reading = true;
	const reader = (async () => {
		while (reading) await fixture.issueCredentials(pair, REVIEWER);
	})();
	const forks = [];
	for (let index = 0; index < 20; index++) {
		forks.push(
			await git(workspace, ANALYST, (env) => env.fork('templates/blank', `busy-${index}`)),
		);
	}
	reading = false;
	await reader;
	check(
		forks.every((outcome) => outcome.ok),
		'a fork beside credential reads was refused',
	);
	const listed = await git(workspace, ANALYST, (env) => env.list('analyst'));
	check(
		listed.length === 21,
		`the forks beside credential reads left ${listed.length} repositories`,
	);
	const twin = await git(workspace, ANALYST, (env) => env.get('analyst/twin'));
	check(twin !== undefined, 'the fork analyst/twin is missing');
	if (twin === undefined) return;
	check(
		await fixture.writeCredential(pair, ANALYST, twin.url),
		'the owner holds no write credential for its fork',
	);
};

const abortedForkRejects: Body = async ({ workspace }) => {
	const controller = new AbortController();
	controller.abort();
	const resource = workspace.git;
	if (resource === undefined) throw new Error('The workspace has no git resource.');
	const rejected = await resource
		.use(ANALYST, (env) => env.fork('templates/blank', 'cut', controller.signal))
		.then(
			() => false,
			() => true,
		);
	check(rejected, 'an aborted fork did not reject');
	const again = await git(workspace, ANALYST, (env) => env.fork('templates/blank', 'cut'));
	check(again.ok || again.reason === 'name_taken', 'a fork after an abort was refused');
};

/** Open a workspace over `store` with `templates`, run `body` in it, and dispose it. */
async function registered<T>(
	store: GitConformanceStore,
	options: GitConformanceOptions,
	body: (workspace: Workspace) => Promise<T>,
): Promise<T> {
	// Registration cases reopen a workspace over one persistent store. Each
	// workspace opens a new git backend and a new bash backend.
	const workspace = openWorkspace({
		name: 'git-conformance',
		backend: { bash: store.bash(store.backend(options)) },
	});
	try {
		return await body(workspace);
	} finally {
		await workspace.dispose();
	}
}

/** The commit at the tip of `main` in the repository `id`. */
async function mainOf(workspace: Workspace, id: string): Promise<string | undefined> {
	return (await git(workspace, ANALYST, (env) => env.get(id)))?.branches.main;
}

const CHANGED: GitConformanceOptions['templates'] = {
	...TEMPLATES,
	blank: {
		description: 'An empty start.',
		files: { 'NOTES.md': 'changed\n', '.gitignore': 'NOTES.md\n' },
	},
};

/** Fork the updated `templates/blank` as `late`, clone it, and check its files and its history. */
async function checkLateFork(workspace: Workspace, before: string): Promise<void> {
	const url = await forkAs(workspace, ANALYST, 'templates/blank', 'late');
	const clone = await sh(
		workspace,
		ANALYST,
		`git clone ${url} ~/late && cd ~/late && git log --format=%H`,
	);
	check(clone.code === 0, `the clone of the updated template failed: ${clone.output}`);
	check(clone.output.includes(before), 'the update did not fast-forward from the old tip');
	const notes = await workspace.use(ANALYST, (env) => env.readTextFile('~/late/NOTES.md', ctx));
	check(notes.ok && notes.value === 'changed\n', 'a fork after the update lacks the new file');
	const readme = await workspace.use(ANALYST, (env) => env.readTextFile('~/late/README.md', ctx));
	check(!readme.ok, 'a fork after the update keeps a file that the source removed');
}

const registrationFollowsSource = async <B extends GitBackend>(
	store: GitConformanceStore<B>,
): Promise<void> => {
	const before = await registered(store, { templates: TEMPLATES }, async (workspace) => {
		await forkAs(workspace, ANALYST, 'templates/blank', 'early');
		return mainOf(workspace, 'templates/blank');
	});
	check(typeof before === 'string', 'the first registration made no template');
	const again = await registered(store, { templates: TEMPLATES }, (w) =>
		mainOf(w, 'templates/blank'),
	);
	check(again === before, 'a second registration wrote a commit');
	const updated = await registered(store, { templates: CHANGED }, async (workspace) => {
		const template = await git(workspace, ANALYST, (env) => env.get('templates/blank'));
		check(template?.description === 'An empty start.', 'the description did not update');
		check(
			(await mainOf(workspace, 'analyst/early')) === before,
			'the update moved a fork made before it',
		);
		await checkLateFork(workspace, before ?? '');
		return template?.branches.main;
	});
	check(updated !== undefined && updated !== before, 'a changed source did not update');
	const last = await registered(store, { templates: CHANGED }, (w) => mainOf(w, 'templates/blank'));
	check(last === updated, 'a registration after the update wrote a commit');
};

const REFUSED: readonly [GitConformanceOptions, string][] = [
	[
		{ templates: { bad: { files: { '../x': 'y' } } } },
		"The template 'bad' holds the path '../x', which leaves its root.",
	],
	[
		{ templates: {}, shared: { bad: { source: { '.git/config': 'y' } } } },
		"The shared repository 'bad' holds the path '.git/config', which leaves its root.",
	],
];

const refusesPathsOutsideTheRoot = async <B extends GitBackend>(
	store: GitConformanceStore<B>,
): Promise<void> => {
	for (const [options, message] of REFUSED) {
		await registered(store, options, async (workspace) => {
			// A failed registration lets the next call try again, and it fails the same way.
			for (const attempt of ['first', 'second']) {
				const error = await git(workspace, ANALYST, (env) => env.list()).then(
					() => undefined,
					(reason: unknown) => reason,
				);
				check(
					error instanceof Error && error.message.includes(message),
					`the ${attempt} call after a refused registration did not name it: ${String(error)}`,
				);
			}
		});
	}
};

const credentialExpires = async <B extends GitBackend>(
	fixture: GitConformanceBackend<B>,
	store: GitConformanceStore<B>,
): Promise<void> => {
	if (fixture.shortestCredentialTtl > 5) return;
	await withWorkspace(
		fixture,
		store,
		async (pair, hooks) => {
			await git(pair.workspace, ANALYST, (env) => env.list());
			const probe = await hooks.probeCredential(pair, ANALYST);
			check(await probe.accepted(), 'a fresh credential was refused');
			await new Promise((resolve) => setTimeout(resolve, probe.expiresAt - Date.now() + 250));
			check(!(await probe.accepted()), 'an expired credential was accepted');
		},
		{
			templates: TEMPLATES,
			shared: SHARED_FIXTURE,
			credentialTtl: fixture.shortestCredentialTtl,
		},
	);
};

const CASES: readonly [string, Body][] = [
	[
		'repos lists each template with its description, and each fork with its source',
		listsTemplatesAndForks,
	],
	['a clone of a fork has the fork as origin', cloneSetsOrigin],
	['a second fork with a taken name is name_taken and creates nothing', takenNameCreatesNothing],
	['a fork of a missing source is no_source', missingSourceIsRefused],
	['a fork of a fork names its direct source', forkOfForkNamesItsSource],
	[
		'agents named templates or shared are refused for repositories and credentials',
		reservedNamespaceIsRefused,
	],
	['the owner pushes a branch, and a peer reads it', ownerPushesPeerReads],
	[
		'resolve gives the commit of a branch, a tag, or a hash, and show gives what the commit holds',
		resolvesBranchTagAndHash,
	],
	[
		"a push to a template or to another agent's fork is refused",
		pushesOutsideTheNamespaceAreRefused,
	],
	['an aborted fork rejects, and a repeated call is safe', abortedForkRejects],
	[
		'two forks of one name keep one fork, and credential reads beside forks lose none',
		concurrentForksKeepOneFork,
	],
];

/** The cases of a git backend, as named test bodies. Each case opens a fresh store. */
export function gitConformance<B extends GitBackend>(
	fixture: GitConformanceBackend<B>,
): readonly ConformanceCase[] {
	const inWorkspace =
		(body: Body) =>
		(store: GitConformanceStore<B>): Promise<void> =>
			withWorkspace(fixture, store, body);
	const sharedCase =
		(body: (workspace: Workspace) => Promise<void>) =>
		(store: GitConformanceStore<B>): Promise<void> =>
			withWorkspace(fixture, store, ({ workspace }) => body(workspace));
	return conformanceSuite(fixture, [
		...CASES.map(([name, body]) => [name, inWorkspace(body)] as const),
		[
			'a registration with the same source writes nothing, and a changed one fast-forwards the template',
			registrationFollowsSource,
		],
		['a registration with a path that leaves its root is refused', refusesPathsOutsideTheRoot],
		[
			'a shared repository persists through restart, ignores changed and unreadable sources, and stays writable when omitted',
			(store) => sharedRegistrationPersists(store, SHARED_FIXTURE),
		],
		[
			'both agents push shared main, and a stale second push rebases with both commits intact',
			sharedCase(sharedPushesMergeFromBothAgents),
		],
		[
			'two concurrent same-base pushes to shared main have one winner and one rejection',
			sharedCase(concurrentSharedMainPushes),
		],
		[
			'shared main refuses deletion and non-fast-forward updates, while side branches can be rewritten or deleted',
			sharedCase(sharedMainAndSideBranchPolicy),
		],
		[
			'a fork of a shared repository has ordinary permissions and its refs roundtrip',
			sharedCase(sharedForkAndRefsRoundTrip),
		],
		[
			'git guidance explains shared repository names and shared main policy',
			sharedCase(sharedGuidanceExplainsPushPolicy),
		],
		['a credential is refused after it expires', (store) => credentialExpires(fixture, store)],
	]);
}
