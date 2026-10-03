/**
 * The `repos` and `fork` tools over a git backend.
 *
 * A workspace with a git backend gives its agents these tools. Each
 * tool does one thing. `repos` lists the repositories with their clone
 * URLs. `fork` forks a repository into the calling agent's namespace, and
 * may also put a working copy of that fork in the agent's files. An agent
 * that wants a working copy of another repository runs `git clone` with
 * `bash`, and the git note states how.
 * An agent writes a commit ref itself, from `git rev-parse`; the git note
 * states the form.
 *
 * `fork` forks on the git resource, and that operation ends before the
 * clone starts. The clone then runs as one operation on the bash resource,
 * as the calling agent. No git operation holds a bash operation, so
 * neither resource waits on the other.
 *
 * A refusal comes back as text that tells the agent what to do next. A
 * fault and an abort reject. `docs/git.md` states the texts.
 */

import { type AmbionTool, defineTool, type ToolContext } from '@ambionframework/ambion';
import { type Static, Type } from 'typebox';
import type { WorkspaceEnv } from './backend.ts';
import type { Capability } from './capability.ts';
import { runScript, shellQuote } from './execution-env.ts';
import type { GitEnv, GitRepository } from './git-backend.ts';
import { NAME_PATTERN } from './git-names.ts';
import { unwrap } from './object-files.ts';
import type { WorkspaceResource } from './resource.ts';
import type { DetailedResult } from './tools.ts';

/** The most branches one line of the `repos` table shows. */
const SHOWN_BRANCHES = 5;

/** Seconds a clone may run. A clone of a large template takes longer than a command. */
const CLONE_TIMEOUT_SECONDS = 300;

/** How much of a failed clone's output the result keeps. */
const CLONE_OUTPUT = { maxBytes: 4000, maxLines: 20 };

/** What the git tools need from the workspace: the two resources and the server name. */
export interface GitToolOptions {
	readonly git: WorkspaceResource<GitEnv>['use'];
	readonly bash: WorkspaceResource<WorkspaceEnv>['use'];
	readonly server: string;
}

/**
 * Guidance for the git tools over a server that the workspace names
 * `server`, in the workspace `workspace`, the first part of a commit ref.
 */
export function gitToolGuidance(server: string, workspace: string): string {
	return [
		`repos and fork reach the git server of this workspace, ${server}.`,
		`templates/<name> is a read-only template. shared/<name> is a repository every agent can write.`,
		`<agent>/<name> belongs to that agent. You can read every repository.`,
		`You push to <your name>/<name> and to shared/<name>. Before a shared push, fetch and rebase onto origin/main.`,
		`If a push is rejected because another agent pushed first, fetch, rebase, resolve conflicts, and retry.`,
		`To check out a repository without forking it, take its clone URL from repos and run git clone <url> <path> with bash.`,
		`Its origin is the source, with the source's push permissions: a clone of shared/<name> pushes back to it,`,
		`and a clone of a template or of another agent's fork is read-only. Raise wait for a large repository.`,
		`To make work of your own that you can push, call fork with clone.`,
		`In that clone, make a branch, commit, and push to origin with git in bash.`,
		`An edit persists only after you commit it and push it. Push before you finish.`,
		`To cite a commit you pushed, put its full hash from git rev-parse in the refs of a say:`,
		`ambion://workspace/${workspace}/repo/<repository>/branch/<branch>/commit/<hash>. Use`,
		`/tag/<tag> for a tag, or leave both out. Percent-encode the branch or tag name as one URI part, so / is %2F and # is %23.`,
	].join('\n');
}

const reposSchema = Type.Object({
	namespace: Type.Optional(
		Type.String({
			description: 'templates, shared, or the name of an agent. Omit it to list every repository.',
		}),
	),
});

const forkSchema = Type.Object({
	source: Type.String({
		description: 'The repository to fork, such as templates/weekly-report.',
	}),
	name: Type.String({
		pattern: NAME_PATTERN,
		description: 'The name of the fork. The fork is <your name>/<name>.',
	}),
	clone: Type.Optional(
		Type.String({
			description: 'A path for a working copy of the fork, such as ~/report. Omit it to fork only.',
		}),
	),
});

type ReposParams = Static<typeof reposSchema>;
type ForkParams = Static<typeof forkSchema>;

/** The git capability: `repos` and `fork`, and the git note for the workspace `workspace`. */
export function gitCapability(
	options: GitToolOptions & { readonly workspace: string },
): Capability {
	return {
		tools: createGitTools(options),
		notes: [gitToolGuidance(options.server, options.workspace)],
	};
}

/** Build the git tools. Repository operations run on the git resource. */
function createGitTools(options: GitToolOptions): readonly AmbionTool[] {
	const repos = defineTool({
		name: 'repos',
		label: 'Repositories',
		description:
			"List the repositories on the workspace's git server: read-only templates, shared repositories, and every agent's forks, with clone URLs.",
		parameters: reposSchema,
		compose: { output: ReposOutput },
		execute: (params: ReposParams, ctx) => listed(options, params, ctx),
	});
	const fork = defineTool({
		name: 'fork',
		label: 'Fork',
		description:
			'Fork a repository into your own namespace on the git server. Set clone to put a working copy of the fork in your workspace.',
		parameters: forkSchema,
		compose: { output: ForkOutput },
		execute: (params: ForkParams, ctx) => forked(options, params, ctx),
	});
	return Object.freeze([repos, fork]);
}

// -- repos ---------------------------------------------------------------------

/** The declared output of `repos`: the server, and each repository that the call listed. */
const ReposOutput = Type.Object({
	server: Type.String({ description: 'The name of the git server of the workspace.' }),
	repositories: Type.Array(
		Type.Object({
			id: Type.String({ description: 'The repository, such as templates/weekly-report.' }),
			description: Type.Optional(Type.String({ description: 'What the repository holds.' })),
			source: Type.Optional(Type.String({ description: 'The repository that this one forks.' })),
			defaultBranch: Type.String({ description: 'The branch that a clone checks out.' }),
			branches: Type.Record(Type.String(), Type.String(), {
				description: 'Each branch, with the full hash of the commit that it names.',
			}),
			url: Type.String({ description: 'The clone URL.' }),
		}),
	),
});

type ReposDetails = Static<typeof ReposOutput>;

async function listed(
	options: GitToolOptions,
	params: ReposParams,
	ctx: ToolContext,
): Promise<DetailedResult<ReposDetails>> {
	const repositories = await options.git(
		ctx.agent,
		(env) => env.list(params.namespace, ctx.signal),
		ctx.signal,
	);
	const details: ReposDetails = {
		server: options.server,
		repositories: repositories.map(repositoryFacts),
	};
	if (repositories.length === 0) return report(`No repositories on ${options.server}.`, details);
	return report(reposTable(repositories), details);
}

/** The facts of one repository for `details`. A field that is absent stays absent. */
function repositoryFacts(repository: GitRepository): ReposDetails['repositories'][number] {
	const { id, description, source, defaultBranch, branches, url } = repository;
	return {
		id,
		...(description === undefined ? {} : { description }),
		...(source === undefined ? {} : { source }),
		defaultBranch,
		branches: { ...branches },
		url,
	};
}

/** One line for each repository, and a count. */
function reposTable(repositories: readonly GitRepository[]): string {
	const header = '| Repository | Description | Forked from | Branches | URL |';
	const rule = '| --- | --- | --- | --- | --- |';
	const body = repositories.map((repository) =>
		[
			repository.id,
			repository.description ?? '',
			repository.source ?? '',
			branchesOf(repository),
			repository.url,
		]
			.map(cell)
			.join(' | '),
	);
	const count = repositories.length;
	const footer = `${count} ${count === 1 ? 'repository' : 'repositories'}.`;
	const table = [header, rule, ...body.map((line) => `| ${line} |`)].join('\n');
	return `${table}\n\n${footer}`;
}

/** The default branch first, then the others by name, each with its short commit. */
function branchesOf(repository: GitRepository): string {
	const names = Object.keys(repository.branches).sort((a, b) =>
		a === repository.defaultBranch ? -1 : b === repository.defaultBranch ? 1 : a.localeCompare(b),
	);
	const shown = names
		.slice(0, SHOWN_BRANCHES)
		.map((name) => `${name} ${repository.branches[name]?.slice(0, 7) ?? ''}`);
	const more = names.length - shown.length;
	return more > 0 ? `${shown.join(', ')}, and ${more} more` : shown.join(', ');
}

/** One table cell, with pipes and newlines made safe. */
function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// -- fork ----------------------------------------------------------------------

/** The declared output of `fork`: the repository that the fork made or found, and the clone. */
const ForkOutput = Type.Object({
	repository: Type.String({ description: 'The id of the fork.' }),
	source: Type.String({ description: 'The repository that the call forked.' }),
	url: Type.String({ description: 'The clone URL of the fork.' }),
	clone: Type.Optional(
		Type.String({ description: 'The path of the working copy, when the call made one.' }),
	),
});

type ForkDetails = Static<typeof ForkOutput>;

async function forked(
	options: GitToolOptions,
	params: ForkParams,
	ctx: ToolContext,
): Promise<DetailedResult<ForkDetails>> {
	const outcome = await options.git(
		ctx.agent,
		(env) => env.fork(params.source, params.name, ctx.signal),
		ctx.signal,
	);
	if (!outcome.ok && outcome.reason === 'no_source')
		throw new Error(`${params.source} does not exist. Call repos to list the repositories.`);
	if (!outcome.ok && outcome.reason === 'refused')
		throw new Error(
			`The git server refused the fork: ${outcome.message} Call repos to see what exists.`,
		);
	const repository = outcome.repository;
	const lead = outcome.ok
		? `Forked ${params.source} to ${repository.id}. Clone URL: ${repository.url}`
		: `${repository.id} exists. Clone URL: ${repository.url}.`;
	const details: ForkDetails = {
		repository: repository.id,
		source: params.source,
		url: repository.url,
	};
	if (params.clone === undefined) return report(lead, details);
	const clone = await cloneInto(options, repository, params.clone, !outcome.ok, ctx);
	// The fork stands, and a failed clone still fails the call: the agent asked for a working copy.
	if (clone.failed) throw new Error(`${lead}\n${clone.text}`);
	return report(`${lead}\n${clone.text}`, { ...details, clone: clone.path });
}

/**
 * Clone `repository` into `path`, as one operation on the bash resource. A
 * repeated fork (`existing`) clones only when the path does not exist yet.
 */
async function cloneInto(
	options: GitToolOptions,
	repository: GitRepository,
	path: string,
	existing: boolean,
	ctx: ToolContext,
): Promise<{ path: string; text: string; failed?: true }> {
	const { signal } = ctx;
	return options.bash(
		ctx.agent,
		async (env) => {
			const target = unwrap(await env.absolutePath(path, signal), `Cannot clone into ${path}`);
			if (existing) {
				const found = await env.exists(target, signal);
				if (found.ok && found.value) {
					return { path: target, text: `${target} already exists, so the tool made no clone.` };
				}
			}
			const failure = await gitClone(env, repository.url, target, signal);
			if (failure === undefined) {
				return {
					path: target,
					text: `Cloned it into ${target} on branch ${repository.defaultBranch}. origin is the fork.`,
				};
			}
			return {
				path: target,
				text: `The clone into ${target} failed: ${failure}. The fork stays. Run git clone ${repository.url} ${target} with bash.`,
				failed: true,
			};
		},
		ctx.signal,
	);
}

/** Run `git clone`. Resolves with nothing on success, and with the output on a failure. */
async function gitClone(
	env: WorkspaceEnv,
	url: string,
	target: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const ran = await runScript(
		env,
		`git clone ${shellQuote(url)} ${shellQuote(target)}`,
		{ timeout: CLONE_TIMEOUT_SECONDS, capture: { limits: CLONE_OUTPUT } },
		signal,
	);
	if (!ran.ok) {
		// An abort rejects the call. Any other failure is text for the agent.
		if (signal?.aborted) throw ran.error;
		return ran.error.message;
	}
	if (ran.value.exitCode === 0) return undefined;
	const text = ran.value.output.trim();
	return text === '' ? `git exited with status ${ran.value.exitCode}` : text;
}

function report<T>(text: string, details: T): DetailedResult<T> {
	return { content: [{ type: 'text', text }], details };
}
