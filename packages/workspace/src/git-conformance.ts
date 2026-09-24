/**
 * The cases every git backend (`GitBackend`) must pass, together with a
 * bash backend whose `git` reaches it.
 *
 * A harness opens a store: one bash backend, and a factory that opens a git
 * backend over the same repositories each time it is called. A case opens
 * a workspace over the two, drives it as agents through `use` and through
 * `git` in the shell, and checks what the contract states. A refused push
 * is checked by the exit status of `git push`: the text of a refusal
 * differs from one backend to the other.
 *
 * ```ts
 * describe.each(harnesses)('$name', (harness) => {
 * 	for (const c of gitConformance(harness)) it(c.name, c.run);
 * });
 * ```
 */

import type { ConformanceCase } from '@ambionframework/ambion/conformance';
import { BACKGROUND_CONTEXT, type ShellOutputUpdate } from '@earendil-works/pi-agent-core';
import type { BashBackend } from './backend.ts';
import type { GitBackend, GitEnv } from './git-backend.ts';
import type { WorkspaceAgent } from './resource.ts';
import { openWorkspace, type Workspace } from './workspace.ts';

/** One template, as a case registers it. */
export interface GitConformanceTemplate {
	readonly description?: string;
	readonly files: Readonly<Record<string, string>>;
}

/** What a case asks of a git backend. */
export interface GitConformanceOptions {
	readonly templates: Readonly<Record<string, GitConformanceTemplate>>;
	/** Seconds a credential lives. */
	readonly tokenTtl?: number;
}

/** One store of repositories, and a bash backend beside it. */
export interface GitConformanceStore {
	readonly bash: BashBackend;
	/** Open a git backend over this store's repositories. */
	backend(options: GitConformanceOptions): GitBackend;
	dispose(): Promise<void>;
}

/** A git backend under test. `open` runs inside every case. */
export interface GitConformanceBackend {
	readonly name: string;
	/** The shortest `tokenTtl`, in seconds, that the backend takes. */
	readonly shortestTokenTtl: number;
	open(): Promise<GitConformanceStore>;
}

const ctx = BACKGROUND_CONTEXT;

const ANALYST: WorkspaceAgent = { name: 'analyst' };
const REVIEWER: WorkspaceAgent = { name: 'reviewer' };

const TEMPLATES: GitConformanceOptions['templates'] = {
	'weekly-report': {
		description: 'A weekly status report.',
		files: { 'report.md': '# Week\n', 'data/numbers.csv': 'a,b\n1,2\n' },
	},
	blank: { files: { 'README.md': 'blank\n' } },
};

function check(condition: boolean, what: string): void {
	if (!condition) throw new Error(what);
}

interface Opened {
	readonly backend: GitBackend;
	readonly workspace: Workspace;
}

/** Run `body` over a fresh store and a workspace over it, and dispose both after. */
async function withWorkspace(
	harness: GitConformanceBackend,
	body: (opened: Opened) => Promise<void>,
	options: GitConformanceOptions = { templates: TEMPLATES },
): Promise<void> {
	const store = await harness.open();
	const backend = store.backend(options);
	const workspace = openWorkspace({
		name: 'git-conformance',
		backend: { bash: store.bash, git: backend },
	});
	try {
		await body({ backend, workspace });
	} finally {
		await workspace.dispose();
		await store.dispose();
	}
}

/** Run `operation` on the git owner as `agent`. */
function git<T>(
	workspace: Workspace,
	agent: WorkspaceAgent,
	operation: (env: GitEnv) => Promise<T>,
): Promise<T> {
	const owner = workspace.git;
	if (owner === undefined) throw new Error('The workspace has no git owner.');
	return owner.use(agent, operation);
}

/**
 * Run one shell command as `agent`, and give its exit status and its output.
 * The author variables let a real `git` commit. The just-bash `git` locks
 * the author to the agent, and ignores them.
 */
async function sh(
	workspace: Workspace,
	agent: WorkspaceAgent,
	command: string,
): Promise<{ code: number; output: string }> {
	let output = '';
	const onUpdate = (update: ShellOutputUpdate): void => {
		if (update.kind === 'replace') output = update.output.text;
	};
	const ran = await workspace.use(agent, (env) =>
		env.exec(
			command,
			{
				timeout: 120,
				env: authorOf(agent),
				capture: { limits: { maxBytes: 100_000, maxLines: 1000 } },
				onUpdate,
			},
			ctx,
		),
	);
	if (!ran.ok) throw ran.error;
	return { code: ran.value.exitCode, output };
}

/** The author and committer variables of `agent`. */
function authorOf(agent: WorkspaceAgent): Record<string, string> {
	const email = `${agent.name}@ambion.invalid`;
	return {
		GIT_AUTHOR_NAME: agent.name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: agent.name,
		GIT_COMMITTER_EMAIL: email,
	};
}

/** Fork `source` to `<agent>/<name>`, and give the fork's clone URL. */
async function forkAs(
	workspace: Workspace,
	agent: WorkspaceAgent,
	source: string,
	name: string,
): Promise<string> {
	const outcome = await git(workspace, agent, (env) => env.fork(source, name));
	if (!outcome.ok)
		throw new Error(`the fork of ${source} to ${name} was refused: ${outcome.reason}`);
	return outcome.repository.url;
}

// -- the cases ----------------------------------------------------------------

type Body = (opened: Opened) => Promise<void>;

const listsTemplatesAndForks: Body = async ({ workspace }) => {
	await forkAs(workspace, ANALYST, 'templates/weekly-report', 'report');
	const all = await git(workspace, ANALYST, (env) => env.list());
	const ids = all.map((repository) => repository.id);
	check(
		JSON.stringify(ids) ===
			JSON.stringify(['analyst/report', 'templates/blank', 'templates/weekly-report']),
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
};

const sourcesStayHidden: Body = async ({ workspace, backend }) => {
	const all = await git(workspace, ANALYST, (env) => env.list());
	check(
		all.every((repository) => !repository.id.startsWith('template-sources/')),
		'list shows template-sources',
	);
	const hidden = await git(workspace, ANALYST, (env) => env.get('template-sources/blank'));
	check(hidden === undefined, 'get reaches template-sources');
	const credentials = await backend.access.credentialsFor(ANALYST);
	check(
		credentials.every((credential) => !credential.url.includes('template-sources')),
		'an agent holds a credential for template-sources',
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
	const hidden = await git(workspace, ANALYST, (env) => env.fork('template-sources/blank', 'y'));
	check(!hidden.ok && hidden.reason === 'no_source', 'template-sources was forkable');
};

const forkOfForkNamesItsSource: Body = async ({ workspace }) => {
	await forkAs(workspace, ANALYST, 'templates/weekly-report', 'report');
	await forkAs(workspace, REVIEWER, 'analyst/report', 'review');
	const review = await git(workspace, REVIEWER, (env) => env.get('reviewer/review'));
	check(review?.source === 'analyst/report', 'a fork of a fork does not name its direct source');
};

const reservedNamesAreRefused: Body = async ({ workspace, backend }) => {
	for (const name of ['templates', 'template-sources']) {
		const refused = await git(workspace, { name }, (env) => env.list()).then(
			() => false,
			() => true,
		);
		check(refused, `an agent named ${name} was not refused`);
		const credential = await backend.access.credentialsFor({ name }).then(
			() => false,
			() => true,
		);
		check(credential, `an agent named ${name} got credentials`);
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

const concurrentForksKeepOneFork: Body = async ({ backend, workspace }) => {
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
	// A workstation reads the credentials at every connect, beside the forks of other agents.
	let reading = true;
	const reader = (async () => {
		while (reading) await backend.access.credentialsFor(REVIEWER);
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
	const credentials = await backend.access.credentialsFor(ANALYST);
	const twin = credentials.find((credential) => credential.url.endsWith('/analyst/twin'));
	check(twin?.scope === 'write', 'the owner holds no write credential for its fork');
};

const abortedForkRejects: Body = async ({ workspace }) => {
	const controller = new AbortController();
	controller.abort();
	const owner = workspace.git;
	if (owner === undefined) throw new Error('The workspace has no git owner.');
	const rejected = await owner
		.use(ANALYST, (env) => env.fork('templates/blank', 'cut', controller.signal))
		.then(
			() => false,
			() => true,
		);
	check(rejected, 'an aborted fork did not reject');
	const again = await git(workspace, ANALYST, (env) => env.fork('templates/blank', 'cut'));
	check(again.ok || again.reason === 'name_taken', 'a fork after an abort was refused');
};

const sameSourceWritesNothing = async (harness: GitConformanceBackend): Promise<void> => {
	const store = await harness.open();
	try {
		const first = openWorkspace({
			name: 'git-conformance',
			backend: { bash: store.bash, git: store.backend({ templates: TEMPLATES }) },
		});
		const before = await git(first, ANALYST, (env) => env.get('templates/blank'));
		await first.dispose();
		const second = openWorkspace({
			name: 'git-conformance',
			backend: { bash: store.bash, git: store.backend({ templates: TEMPLATES }) },
		});
		const after = await git(second, ANALYST, (env) => env.get('templates/blank'));
		await second.dispose();
		check(typeof before?.branches.main === 'string', 'the first registration made no template');
		check(after?.branches.main === before?.branches.main, 'a second registration wrote a commit');
		const changed = { ...TEMPLATES, blank: { files: { 'README.md': 'changed\n' } } };
		const third = openWorkspace({
			name: 'git-conformance',
			backend: { bash: store.bash, git: store.backend({ templates: changed }) },
		});
		const message = await git(third, ANALYST, (env) => env.list()).then(
			() => '',
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await third.dispose();
		check(message.includes('blank'), `a changed template did not fail with its name: ${message}`);
	} finally {
		await store.dispose();
	}
};

const credentialExpires = async (harness: GitConformanceBackend): Promise<void> => {
	if (harness.shortestTokenTtl > 5) return;
	await withWorkspace(
		harness,
		async ({ backend, workspace }) => {
			await git(workspace, ANALYST, (env) => env.list());
			const access = backend.access;
			const url = `${access.prefix}templates/blank`;
			const credential = await access.credentialFor(ANALYST, url);
			check(credential?.scope === 'read', 'an agent holds no read credential for a template');
			if (credential === undefined) return;
			const fetch = access.fetch ?? globalThis.fetch;
			const probe = () =>
				fetch(`${credential.url}/info/refs?service=git-upload-pack`, {
					headers: { Authorization: `Bearer ${credential.token}` },
				});
			check((await probe()).status === 200, 'a fresh credential was refused');
			await new Promise((resolve) => setTimeout(resolve, credential.expiresAt - Date.now() + 250));
			check((await probe()).status === 401, 'an expired credential was accepted');
		},
		{ templates: TEMPLATES, tokenTtl: harness.shortestTokenTtl },
	);
};

const CASES: readonly [string, Body][] = [
	[
		'repos lists each template with its description, and each fork with its source',
		listsTemplatesAndForks,
	],
	['template-sources stays hidden, and no agent holds a credential for it', sourcesStayHidden],
	['a clone of a fork has the fork as origin', cloneSetsOrigin],
	['a second fork with a taken name is name_taken and creates nothing', takenNameCreatesNothing],
	['a fork of a missing source is no_source', missingSourceIsRefused],
	['a fork of a fork names its direct source', forkOfForkNamesItsSource],
	['an agent with a reserved name is refused', reservedNamesAreRefused],
	['the owner pushes a branch, and a peer reads it', ownerPushesPeerReads],
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

/** The cases of a git backend, as named test bodies. */
export function gitConformance(harness: GitConformanceBackend): readonly ConformanceCase[] {
	return [
		...CASES.map(([name, body]) => ({ name, run: () => withWorkspace(harness, body) })),
		{
			name: 'a registration with the same source writes nothing, and a changed one fails with its name',
			run: () => sameSourceWritesNothing(harness),
		},
		{ name: 'a credential is refused after it expires', run: () => credentialExpires(harness) },
	];
}
