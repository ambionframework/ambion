/**
 * `justGitBackend`: a `just-git` server in the host's process.
 *
 * The backend opens its storage and its server on first use, and it
 * registers its templates before its first operation: the first `connect`
 * and the first `credentialFor` await one registration. A failed
 * registration rejects that operation, and the next operation tries again.
 *
 * A clone URL is `http://git.ambion.invalid/<namespace>/<name>`. The name
 * never resolves. `access.fetch` passes each request to the server in the
 * same process, so no DNS lookup and no socket take part.
 *
 * An agent holds a write credential for each repository in its namespace,
 * and a read credential for every template and every other agent's fork.
 * No agent holds a credential for `template-sources`.
 */

import type { GitBackend, GitEnv, GitForkOutcome, GitRepository } from '@ambionframework/workspace';
import {
	assertAgent,
	namespaceOf,
	SOURCES,
	type TemplateRegistration,
	validName,
} from '@ambionframework/workspace/git';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { listBranches, readHead } from 'just-git/repo';
import type { GitServer } from 'just-git/server';
import type { GitCredential, GitFetch, JustGitAccess } from './access.ts';
import { DEFAULT_BRANCH, registerTemplates, settleAll } from './registration.ts';
import { openServer, repositoryOfPath } from './server.ts';
import type { GitStorage, OpenGitStorage, RegistryRow } from './storage.ts';
import { signToken, type TokenClaims } from './tokens.ts';

/** The base of every clone URL. `.invalid` never resolves. */
const BASE = 'http://git.ambion.invalid';

/** Seconds a token lives when the host names no `tokenTtl`. */
const DEFAULT_TOKEN_TTL = 3600;

export interface JustGitBackendOptions {
	/** `sqliteGitStorage(path)`, or `sqliteGitStorage(':memory:')` for tests. */
	readonly storage: GitStorage;
	/** The key of every token. A new secret revokes every token. */
	readonly secret: string;
	/** The templates, by name. */
	readonly templates?: Readonly<Record<string, TemplateRegistration>>;
	/** Seconds a token lives. The default is 3600. */
	readonly tokenTtl?: number;
	/** Called with a fault of the server that the client sees as status 500. Absent, the backend reports nothing. */
	readonly onError?: (error: unknown) => void;
}

/** The git backend over `just-git`. Its access carries each request in the process. */
export interface JustGitBackend extends GitBackend {
	readonly access: JustGitAccess;
}

interface Opened {
	readonly store: OpenGitStorage;
	readonly server: GitServer<TokenClaims>;
	readonly fetch: GitFetch;
}

/** The life of a token in seconds, after the options are checked. */
function checked(options: JustGitBackendOptions): number {
	if (options.secret === '') throw new Error('justGitBackend needs a secret.');
	const ttl = options.tokenTtl ?? DEFAULT_TOKEN_TTL;
	if (!Number.isFinite(ttl) || ttl <= 0)
		throw new Error('tokenTtl must be a finite number above 0.');
	return ttl;
}

/** A git backend over a `just-git` server in the host's process. */
export function justGitBackend(options: JustGitBackendOptions): JustGitBackend {
	const ttl = checked(options);
	let opened: Opened | undefined;
	let registering: Promise<void> | undefined;
	let closed = false;

	const open = (): Opened => {
		if (closed) throw new Error('The git backend is disposed.');
		if (opened !== undefined) return opened;
		const store = options.storage.open();
		const server = openServer({
			storage: store.storage,
			secret: options.secret,
			...(options.onError === undefined ? {} : { onError: options.onError }),
		});
		const network = server.asNetwork(BASE);
		const fetch: GitFetch = (input, init) => (network.fetch ?? globalThis.fetch)(input, init);
		opened = { store, server, fetch };
		return opened;
	};

	/**
	 * One registration, shared by every caller, then one settle of the rows
	 * that a crash left. A failure lets the next caller try again.
	 */
	const ready = (): Promise<Opened> => {
		const current = open();
		registering ??= (async () => {
			await registerTemplates(current.store, current.server, options.templates ?? {});
			await settleAll(current.store);
		})().catch((error: unknown) => {
			registering = undefined;
			throw error;
		});
		return registering.then(() => current);
	};

	const repositories = new Repositories(ready);

	const credential = (agent: WorkspaceAgent, row: RegistryRow): GitCredential => {
		const scope = namespaceOf(row.id) === agent.name ? 'write' : 'read';
		const expiresAt = Date.now() + ttl * 1000;
		const token = signToken(options.secret, {
			agent: agent.name,
			repository: row.id,
			scope,
			expiresAt,
		});
		return { url: `${BASE}/${row.id}`, scope, token, expiresAt };
	};

	const access: JustGitAccess = {
		transport: 'in-process',
		prefix: `${BASE}/`,
		fetch: (input, init) => open().fetch(input, init),
		credentialFor: async (agent, url) => {
			assertAgent(agent);
			const id = url.startsWith(`${BASE}/`) ? repositoryOfPath(new URL(url).pathname) : undefined;
			const row = id === undefined ? undefined : await repositories.row(id);
			return row === undefined ? undefined : credential(agent, row);
		},
	};

	return Object.freeze({
		access,
		server: BASE,
		connect: async (agent: WorkspaceAgent): Promise<GitEnv> => {
			assertAgent(agent);
			await ready();
			return repositories.envFor(agent);
		},
		dispose: async () => {
			closed = true;
			const current = opened;
			if (current === undefined) return;
			// The server drains the requests in flight before the storage closes.
			await current.server.close();
			current.store.close();
			opened = undefined;
		},
	});
}

/** The repositories of one backend, as the contract reports them. */
class Repositories {
	constructor(private readonly ready: () => Promise<Opened>) {}

	/** The forks in flight, by target ID. A second fork of one target waits for the first. */
	private readonly forking = new Map<string, Promise<GitForkOutcome>>();

	/**
	 * Every ready repository that an agent reaches, in ID order. A read
	 * changes no row: a `forking` row is a fork in flight, and `ready()`
	 * settled every row that a crash left before the first operation.
	 */
	async rows(): Promise<RegistryRow[]> {
		const { store } = await this.ready();
		return store.registry
			.all()
			.filter((row) => row.state === 'ready' && namespaceOf(row.id) !== SOURCES);
	}

	/** The ready row of `id`, when an agent reaches it. */
	async row(id: string): Promise<RegistryRow | undefined> {
		const namespace = namespaceOf(id);
		if (namespace === undefined || namespace === SOURCES) return undefined;
		const row = (await this.ready()).store.registry.get(id);
		return row?.state === 'ready' ? row : undefined;
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
			url: `${BASE}/${row.id}`,
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
		const target = `${agent.name}/${name}`;
		const inFlight = this.forking.get(target);
		if (inFlight !== undefined) return this.taken(await inFlight.catch(() => undefined), target);
		// The fork takes its place before its first await, so a second fork of one target waits for it.
		const made = this.forkChecked(source, target, signal);
		this.forking.set(target, made);
		try {
			return await made;
		} finally {
			this.forking.delete(target);
		}
	}

	/** Check the source and the target, then fork. */
	private async forkChecked(
		source: string,
		target: string,
		signal?: AbortSignal,
	): Promise<GitForkOutcome> {
		const sourceRow = await this.row(source);
		const from = sourceRow === undefined ? undefined : await this.describe(sourceRow);
		if (from === undefined) return { ok: false, reason: 'no_source', source };
		const existing = await this.row(target);
		const taken = existing === undefined ? undefined : await this.describe(existing);
		if (taken !== undefined) return { ok: false, reason: 'name_taken', repository: taken };
		signal?.throwIfAborted();
		return this.forkOnce(source, target);
	}

	/** The outcome for a second fork of `target` after the first ends. */
	private async taken(first: GitForkOutcome | undefined, target: string): Promise<GitForkOutcome> {
		const row = await this.row(target);
		const repository = row === undefined ? undefined : await this.describe(row);
		if (repository !== undefined) return { ok: false, reason: 'name_taken', repository };
		return first?.ok === false
			? first
			: { ok: false, reason: 'refused', message: `The fork ${target} failed.` };
	}

	/** Write the row as `forking`, fork, and mark it `ready`. A failure removes a row whose repository is absent. */
	private async forkOnce(source: string, target: string): Promise<GitForkOutcome> {
		const { store, server } = await this.ready();
		if (store.registry.get(target) !== undefined) {
			// A row that is not ready, with no fork in flight: a fork that failed after its repository landed.
			if (await store.storage.hasRepo(target)) {
				store.registry.ready(target);
				return this.taken(undefined, target);
			}
			store.registry.remove(target);
		}
		store.registry.begin(target, source, undefined);
		try {
			await server.forkRepo(source, target);
		} catch (error) {
			if (!(await store.storage.hasRepo(target))) store.registry.remove(target);
			throw error;
		}
		store.registry.ready(target);
		const made = await this.describe({ id: target, source, state: 'ready' });
		if (made === undefined) throw new Error(`The fork ${target} is missing after forkRepo.`);
		return { ok: true, repository: made };
	}
}
