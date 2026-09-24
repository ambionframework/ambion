/**
 * The `repos` and `fork` tools over a git backend.
 *
 * A workspace with a git backend gives its agents these two tools. Each
 * tool does one thing. `repos` lists the repositories with their clone
 * URLs. `fork` forks a repository into the calling agent's namespace, and
 * with `clone` it puts a working copy of the fork in the agent's files.
 *
 * `fork` runs its fork as one operation on the git owner, and that
 * operation ends before the clone starts. The clone then runs as one
 * operation on the bash owner, as the calling agent. No git operation holds
 * a bash operation, so neither owner waits on the other.
 *
 * A refusal comes back as text that tells the agent what to do next. A
 * fault and an abort reject. The audit entry of a call runs on the bash
 * owner after the call ends. `docs/git.md` states the texts.
 */

import { type AmbionTool, defineTool, type ToolContext } from '@ambionframework/ambion';
import {
	type AgentToolResult,
	BACKGROUND_CONTEXT,
	type Context,
	type ShellOutputUpdate,
	withAbortSignal,
} from '@earendil-works/pi-agent-core';
import { type Static, Type } from 'typebox';
import type { AuditLog } from './audit.ts';
import type { WorkspaceEnv } from './backend.ts';
import type { GitEnv, GitRepository } from './git-backend.ts';
import { NAME_PATTERN } from './git-names.ts';
import type { WorkspaceResource } from './resource.ts';
import { recordedOnShell } from './tools.ts';

/** The most branches one line of the `repos` table shows. */
const SHOWN_BRANCHES = 5;

/** Seconds a clone may run. A clone of a large template takes longer than a command. */
const CLONE_TIMEOUT_SECONDS = 300;

/** How much of a failed clone's output the result keeps. */
const CLONE_OUTPUT = { maxBytes: 4000, maxLines: 20 };

/** What the git tools need from the workspace: the two owners, the server name, and the audit log. */
export interface GitToolOptions {
	readonly git: WorkspaceResource<GitEnv>['use'];
	readonly shell: WorkspaceResource<WorkspaceEnv>['use'];
	readonly server: string;
	readonly audit?: AuditLog;
}

/** The tool names, in the order the tool line of the guidance lists them. */
export const GIT_TOOL_NAMES = ['repos', 'fork'] as const;

/** Guidance for the git tools over a server that the workspace names `server`. */
export function gitToolGuidance(server: string): string {
	return [
		`repos and fork reach the git server of this workspace, ${server}.`,
		`templates/<name> is a read-only template. <agent>/<name> belongs to that agent.`,
		`You push only to <your name>/<name>, and you can read every repository.`,
		`To start from a template, fork it and set clone. Clone with the URL that repos or`,
		`fork gives. In the clone, make a branch, commit, and push to origin with git in bash.`,
		`An edit persists only after you commit it and push it. Push before you finish.`,
	].join('\n');
}

const reposSchema = Type.Object({
	namespace: Type.Optional(
		Type.String({
			description: 'templates or the name of an agent. Omit it to list every repository.',
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

/** Build the `repos` and `fork` tools that run on the git owner. */
export function createGitTools(options: GitToolOptions): readonly AmbionTool[] {
	const repos = defineTool({
		name: 'repos',
		label: 'Repositories',
		description:
			"List the repositories on the workspace's git server: the read-only templates and every agent's forks, with clone URLs.",
		parameters: reposSchema,
		execute: recordedOnShell('repos', options.shell, options.audit, (params: ReposParams, ctx) =>
			listed(options, params, ctx),
		),
	});
	const fork = defineTool({
		name: 'fork',
		label: 'Fork',
		description:
			'Fork a repository into your own namespace on the git server. Set clone to put a working copy of the fork in your workspace.',
		parameters: forkSchema,
		execute: recordedOnShell('fork', options.shell, options.audit, (params: ForkParams, ctx) =>
			forked(options, params, ctx),
		),
	});
	return Object.freeze([repos, fork]);
}

// -- repos ---------------------------------------------------------------------

interface ReposDetails {
	server: string;
	repositories: number;
}

async function listed(
	options: GitToolOptions,
	params: ReposParams,
	ctx: ToolContext,
): Promise<AgentToolResult<ReposDetails>> {
	const repositories = await options.git(
		ctx.agent,
		(env) => env.list(params.namespace, ctx.signal),
		ctx.signal,
	);
	const details = { server: options.server, repositories: repositories.length };
	if (repositories.length === 0) return report(`No repositories on ${options.server}.`, details);
	return report(reposTable(repositories), details);
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

interface ForkDetails {
	repository?: string;
	source: string;
	url?: string;
	clone?: string;
}

async function forked(
	options: GitToolOptions,
	params: ForkParams,
	ctx: ToolContext,
): Promise<AgentToolResult<ForkDetails>> {
	const outcome = await options.git(
		ctx.agent,
		(env) => env.fork(params.source, params.name, ctx.signal),
		ctx.signal,
	);
	if (!outcome.ok && outcome.reason === 'no_source') {
		return report(`${params.source} does not exist. Call repos to list the repositories.`, {
			source: params.source,
		});
	}
	if (!outcome.ok && outcome.reason === 'refused') {
		return report(`The git server refused the fork: ${outcome.message}`, {
			source: params.source,
		});
	}
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
	return report(`${lead}\n${clone.text}`, { ...details, clone: clone.path });
}

/**
 * Clone `repository` into `path`, as one operation on the bash owner. A
 * repeated fork (`existing`) clones only when the path does not exist yet.
 */
async function cloneInto(
	options: GitToolOptions,
	repository: GitRepository,
	path: string,
	existing: boolean,
	ctx: ToolContext,
): Promise<{ path: string; text: string }> {
	const context =
		ctx.signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);
	return options.shell(
		ctx.agent,
		async (env) => {
			const resolved = await env.absolutePath(path, context);
			if (!resolved.ok) throw resolved.error;
			const target = resolved.value;
			if (existing) {
				const found = await env.exists(target, context);
				if (found.ok && found.value) {
					return { path: target, text: `${target} already exists, so the tool made no clone.` };
				}
			}
			const failure = await gitClone(env, repository.url, target, context);
			if (failure === undefined) {
				return {
					path: target,
					text: `Cloned it into ${target} on branch ${repository.defaultBranch}. origin is the fork.`,
				};
			}
			return {
				path: target,
				text: `The clone into ${target} failed: ${failure}. The fork stays; clone ${repository.url}.`,
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
	context: Context,
): Promise<string | undefined> {
	let output = '';
	const onUpdate = (update: ShellOutputUpdate): void => {
		if (update.kind === 'replace') output = update.output.text;
	};
	const ran = await env.exec(
		`git clone ${quote(url)} ${quote(target)}`,
		{ timeout: CLONE_TIMEOUT_SECONDS, capture: { limits: CLONE_OUTPUT }, onUpdate },
		context,
	);
	if (!ran.ok) {
		// An abort rejects the call. Any other failure is text for the agent.
		if (context.abortSignal?.aborted) throw ran.error;
		return ran.error.message;
	}
	if (ran.value.exitCode === 0) return undefined;
	const text = output.trim();
	return text === '' ? `git exited with status ${ran.value.exitCode}` : text;
}

/** One shell word, in single quotes. */
function quote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

function report<T>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: 'text', text }], details };
}
