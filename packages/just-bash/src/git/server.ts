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
 * it. `preReceive` refuses a push to a read-only namespace and a push with
 * a read token.
 */

import { readOnly } from '@ambionframework/workspace/git';
import { createServer, type GitServer, type Storage } from 'just-git/server';
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
			preReceive: ({ repoId, auth }) => {
				if (readOnly(repoId)) return { reject: true, message: `${repoId} is read-only` };
				if (auth.repository !== repoId || auth.scope !== 'write') {
					return { reject: true, message: `${auth.agent} cannot push to ${repoId}` };
				}
				return undefined;
			},
		},
	});
}
