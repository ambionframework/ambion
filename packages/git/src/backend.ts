/**
 * `gitBackend`: a `just-git` server in the host's process.
 *
 * The backend opens its storage and its server on first use, and it
 * registers its templates before its first operation: the first `connect`
 * and the first credential call await one registration. A failed
 * registration rejects that operation, and the next operation tries again.
 *
 * A clone URL is `<url>/<namespace>/<name>`. On the just-bash backends,
 * `access.fetch` passes each request to the server in the same process, so
 * no DNS lookup and no socket take part. A workstation reaches the server
 * over HTTP, through `handler`.
 *
 * An agent holds a write credential for each repository in its namespace,
 * and a read credential for every template and every other agent's fork.
 * No agent holds a credential for `template-sources`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
	GitAccess,
	GitBackend,
	GitCredential,
	GitEnv,
	GitFetch,
	GitForkOutcome,
	GitRepository,
} from '@ambionframework/workspace';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { listBranches, readHead } from 'just-git/repo';
import type { GitServer } from 'just-git/server';
import { assertAgent, namespaceOf, SOURCES, validName } from './names.ts';
import { DEFAULT_BRANCH, registerTemplates, settledRow } from './registration.ts';
import { openServer, repositoryOfPath } from './server.ts';
import type { GitStorage, OpenGitStorage, RegistryRow } from './storage.ts';
import type { TemplateRegistration } from './templates.ts';
import { signToken, type TokenClaims } from './tokens.ts';

/** The base of every clone URL when the host names none. `.invalid` never resolves. */
const DEFAULT_URL = 'http://git.ambion.invalid';

/** Seconds a token lives when the host names no `tokenTtl`. */
const DEFAULT_TOKEN_TTL = 3600;

export interface GitBackendOptions {
	/** `sqliteGitStorage(path)`, or `sqliteGitStorage(':memory:')` for tests. */
	readonly storage: GitStorage;
	/** The key of every token. A new secret revokes every token. */
	readonly secret: string;
	/** The base of every clone URL. The default is `http://git.ambion.invalid`. */
	readonly url?: string;
	/** The templates, by name. */
	readonly templates?: Readonly<Record<string, TemplateRegistration>>;
	/** Seconds a token lives. The default is 3600. */
	readonly tokenTtl?: number;
}

/** The git backend over `just-git`, and the Node request handler that serves it over HTTP. */
export interface JustGitBackend extends GitBackend {
	/** Serve the repositories to a real git client. Listen with `http.createServer(handler)`. */
	handler(request: IncomingMessage, response: ServerResponse): void;
}

interface Opened {
	readonly store: OpenGitStorage;
	readonly server: GitServer<TokenClaims>;
	readonly fetch: GitFetch;
}

function checked(options: GitBackendOptions): { base: string; ttl: number } {
	if (options.secret === '') throw new Error('gitBackend needs a secret.');
	const ttl = options.tokenTtl ?? DEFAULT_TOKEN_TTL;
	if (!(ttl > 0)) throw new Error('tokenTtl must be above 0.');
	const base = (options.url ?? DEFAULT_URL).replace(/\/+$/, '');
	const url = new URL(base);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`The url of a git backend is http or https: '${base}'.`);
	}
	return { base, ttl };
}

/** A git backend over a `just-git` server in the host's process. */
export function gitBackend(options: GitBackendOptions): JustGitBackend {
	const { base, ttl } = checked(options);
	const basePath = new URL(base).pathname.replace(/\/+$/, '');
	let opened: Opened | undefined;
	let registering: Promise<void> | undefined;

	const open = (): Opened => {
		if (opened !== undefined) return opened;
		const store = options.storage.open();
		const server = openServer({ storage: store.storage, secret: options.secret, basePath });
		const network = server.asNetwork(base);
		const fetch: GitFetch = (input, init) => (network.fetch ?? globalThis.fetch)(input, init);
		opened = { store, server, fetch };
		return opened;
	};

	/** One registration, shared by every caller. A failure lets the next caller try again. */
	const ready = (): Promise<Opened> => {
		const current = open();
		registering ??= registerTemplates(current.store, current.server, options.templates ?? {}).catch(
			(error: unknown) => {
				registering = undefined;
				throw error;
			},
		);
		return registering.then(() => current);
	};

	const repositories = new Repositories(base, ready);

	const credential = (agent: WorkspaceAgent, row: RegistryRow): GitCredential => {
		const scope = namespaceOf(row.id) === agent.name ? 'write' : 'read';
		const expiresAt = Date.now() + ttl * 1000;
		const token = signToken(options.secret, {
			agent: agent.name,
			repository: row.id,
			scope,
			expiresAt,
		});
		return { url: `${base}/${row.id}`, scope, token, expiresAt };
	};

	const access: GitAccess = {
		prefix: `${base}/`,
		fetch: (input, init) => open().fetch(input, init),
		credentialFor: async (agent, url) => {
			assertAgent(agent);
			const id = url.startsWith(`${base}/`)
				? repositoryOfPath(new URL(url).pathname, basePath)
				: undefined;
			const row = id === undefined ? undefined : await repositories.row(id);
			return row === undefined ? undefined : credential(agent, row);
		},
		credentialsFor: async (agent) => {
			assertAgent(agent);
			return (await repositories.rows()).map((row) => credential(agent, row));
		},
	};

	return Object.freeze({
		access,
		server: base,
		connect: async (agent: WorkspaceAgent): Promise<GitEnv> => {
			assertAgent(agent);
			await ready();
			return repositories.envFor(agent);
		},
		dispose: async () => {
			const current = opened;
			opened = undefined;
			registering = undefined;
			if (current === undefined) return;
			await current.server.close();
			current.store.close();
		},
		handler: (request: IncomingMessage, response: ServerResponse) =>
			open().server.nodeHandler(request, response),
	});
}

/** The repositories of one backend, as the contract reports them. */
class Repositories {
	constructor(
		private readonly base: string,
		private readonly ready: () => Promise<Opened>,
	) {}

	/** Every ready repository that an agent reaches, in ID order. */
	async rows(): Promise<RegistryRow[]> {
		const { store } = await this.ready();
		const rows: RegistryRow[] = [];
		for (const row of store.registry.all()) {
			if (namespaceOf(row.id) === SOURCES) continue;
			const settled = await settledRow(store, row.id);
			if (settled !== undefined) rows.push(settled);
		}
		return rows;
	}

	/** The row of `id`, when an agent reaches it. */
	async row(id: string): Promise<RegistryRow | undefined> {
		const namespace = namespaceOf(id);
		if (namespace === undefined || namespace === SOURCES) return undefined;
		return settledRow((await this.ready()).store, id);
	}

	/** The repository of `row`, or `undefined` when the storage no longer holds it. */
	async describe(row: RegistryRow): Promise<GitRepository | undefined> {
		const repo = await (await this.ready()).server.repo(row.id);
		if (repo === null) return undefined;
		const branches: Record<string, string> = {};
		for (const entry of await listBranches(repo)) {
			branches[entry.name.replace(/^refs\/heads\//, '')] = entry.hash;
		}
		const head = await readHead(repo);
		return {
			id: row.id,
			url: `${this.base}/${row.id}`,
			...(row.source === undefined ? {} : { source: row.source }),
			...(row.description === undefined ? {} : { description: row.description }),
			defaultBranch: head.branch ?? DEFAULT_BRANCH,
			branches,
		};
	}

	envFor(agent: WorkspaceAgent): GitEnv {
		return {
			list: async (namespace, signal) => {
				const found: GitRepository[] = [];
				for (const row of await this.rows()) {
					signal?.throwIfAborted();
					if (namespace !== undefined && namespaceOf(row.id) !== namespace) continue;
					const repository = await this.describe(row);
					if (repository !== undefined) found.push(repository);
				}
				return found;
			},
			get: async (id) => {
				const row = await this.row(id);
				return row === undefined ? undefined : this.describe(row);
			},
			fork: (source, name, signal) => this.fork(agent, source, name, signal),
			cleanup: async () => undefined,
		};
	}

	private async fork(
		agent: WorkspaceAgent,
		source: string,
		name: string,
		signal?: AbortSignal,
	): Promise<GitForkOutcome> {
		if (!validName(name)) {
			return { ok: false, reason: 'refused', message: `'${name}' is not a valid name.` };
		}
		const sourceRow = await this.row(source);
		const from = sourceRow === undefined ? undefined : await this.describe(sourceRow);
		if (from === undefined) return { ok: false, reason: 'no_source', source };
		const target = `${agent.name}/${name}`;
		const existing = await this.row(target);
		const taken = existing === undefined ? undefined : await this.describe(existing);
		if (taken !== undefined) return { ok: false, reason: 'name_taken', repository: taken };
		signal?.throwIfAborted();
		const { store, server } = await this.ready();
		if (existing !== undefined) store.registry.remove(target);
		store.registry.begin(target, source, undefined);
		try {
			await server.forkRepo(source, target);
		} catch (error) {
			store.registry.remove(target);
			throw error;
		}
		store.registry.ready(target);
		const made = await this.describe({ id: target, source, state: 'ready' });
		if (made === undefined) throw new Error(`The fork ${target} is missing after forkRepo.`);
		return { ok: true, repository: made };
	}
}
