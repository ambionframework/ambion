/**
 * The `just-git` server of one git backend, with its authentication and its
 * push rules.
 *
 * Every request carries a token, as a bearer token or as the password of
 * HTTP basic authentication with any username. `auth.http` checks the
 * signature and the expiry, and that the token names the repository of the
 * request path. A request with no valid token gets 401 with a `Basic`
 * challenge.
 *
 * `advertiseRefs` checks the repository again after the server resolves
 * it. `preReceive` refuses a push to a read-only namespace, a push with a
 * read token, or a deletion or non-fast-forward update to a shared
 * repository's default branch.
 */

import { namespaceOf, readOnly, SHARED } from '@ambionframework/workspace/git';
import { type GitRepo, readHead } from 'just-git/repo';
import { createServer, type GitServer, type RefUpdate, type Storage } from 'just-git/server';
import { SOURCES } from './registration.ts';
import { type TokenClaims, tokenOf, verifyToken } from './tokens.ts';

/** The path suffixes of the git smart HTTP protocol. */
const SERVICE = /\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/**
 * The repository ID that a URL path names, or `undefined` for a path that
 * does not decode. It decodes the path and drops a service suffix. The
 * server resolves each request with this same function, so a token and the
 * server name one repository.
 */
export function repositoryOfPath(pathname: string): string | undefined {
	try {
		return decodeURIComponent(pathname.slice(1)).replace(SERVICE, '').replace(/\/+$/, '');
	} catch {
		return undefined;
	}
}

interface PushRefusal {
	readonly reject: true;
	readonly message: string;
}

function pushRefusal(repoId: string, auth: TokenClaims): PushRefusal | undefined {
	if (readOnly(repoId) || namespaceOf(repoId) === SOURCES)
		return { reject: true, message: `${repoId} is read-only` };
	if (auth.repository !== repoId || auth.scope !== 'write')
		return { reject: true, message: `${auth.agent} cannot push to ${repoId}` };
	return undefined;
}

async function sharedDefaultBranchRefusal(
	repo: GitRepo,
	repoId: string,
	updates: readonly RefUpdate[],
): Promise<PushRefusal | undefined> {
	if (namespaceOf(repoId) !== SHARED) return undefined;
	const branch = (await readHead(repo)).branch ?? 'main';
	const ref = `refs/heads/${branch}`;
	const rejected = updates.find(
		(update) => update.ref === ref && (update.isDelete || (!update.isCreate && !update.isFF)),
	);
	if (rejected === undefined) return undefined;
	const message = rejected.isDelete
		? `cannot delete protected branch ${ref}`
		: `non-fast-forward push to protected branch ${ref}`;
	return { reject: true, message };
}

function challenge(status: 401 | 403, message: string): Response {
	return new Response(`${message}\n`, {
		status,
		headers: status === 401 ? { 'WWW-Authenticate': 'Basic realm="ambion"' } : {},
	});
}

/** Open the server over `storage`. Each URL path is a repository ID. */
export function openServer(options: {
	storage: Storage;
	secret: string;
	onError?: (error: unknown) => void;
}): GitServer<TokenClaims> {
	const { storage, secret } = options;
	return createServer<TokenClaims>({
		storage,
		// The package writes nothing to stdout: a host that wants the faults passes `onError`.
		onError: options.onError ?? false,
		auth: {
			http: (request) => {
				const token = tokenOf(request.headers.get('authorization'));
				const claims = token === undefined ? undefined : verifyToken(secret, token, Date.now());
				if (claims === undefined) return challenge(401, 'A valid token is required.');
				const repository = repositoryOfPath(new URL(request.url).pathname);
				if (repository !== claims.repository) {
					return challenge(403, 'The token does not grant this repository.');
				}
				return claims;
			},
		},
		hooks: {
			advertiseRefs: ({ repoId, auth }) =>
				auth.repository === repoId
					? undefined
					: { reject: true, message: 'The token does not grant this repository.' },
			preReceive: async ({ repo, repoId, auth, updates }) => {
				const refused = pushRefusal(repoId, auth);
				if (refused !== undefined) return refused;
				return sharedDefaultBranchRefusal(repo, repoId, updates);
			},
		},
	});
}
