/**
 * Signed tokens: one scope on one repository, until an expiry.
 *
 * A token is the claims as base64url JSON, then a `.`, then the
 * HMAC-SHA256 of that text under the host's secret, as base64url. The
 * server checks a token by computing the signature again, so the backend
 * stores no credential. A new secret revokes every token at once.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a token grants. */
export interface TokenClaims {
	/** The agent. */
	readonly agent: string;
	/** The repository ID. */
	readonly repository: string;
	readonly scope: 'read' | 'write';
	/** Milliseconds since the epoch. */
	readonly expiresAt: number;
}

const signature = (secret: string, body: string): Buffer =>
	createHmac('sha256', secret).update(body).digest();

/** Sign `claims` under `secret`. */
export function signToken(secret: string, claims: TokenClaims): string {
	const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
	return `${body}.${signature(secret, body).toString('base64url')}`;
}

/** The claims of `token`, or `undefined` when its signature fails or it has expired at `now`. */
export function verifyToken(secret: string, token: string, now: number): TokenClaims | undefined {
	const dot = token.indexOf('.');
	if (dot <= 0) return undefined;
	const body = token.slice(0, dot);
	const given = Buffer.from(token.slice(dot + 1), 'base64url');
	const expected = signature(secret, body);
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
	const claims = parseClaims(body);
	return claims !== undefined && claims.expiresAt > now ? claims : undefined;
}

function parseClaims(body: string): TokenClaims | undefined {
	try {
		const value = JSON.parse(
			Buffer.from(body, 'base64url').toString('utf8'),
		) as Partial<TokenClaims>;
		const { agent, repository, scope, expiresAt } = value;
		if (typeof agent !== 'string' || typeof repository !== 'string') return undefined;
		if ((scope !== 'read' && scope !== 'write') || typeof expiresAt !== 'number') return undefined;
		return { agent, repository, scope, expiresAt };
	} catch {
		return undefined;
	}
}

/** The token of an `Authorization` header: a bearer token, or the password of basic authentication. */
export function tokenOf(header: string | null): string | undefined {
	if (header === null) return undefined;
	const [kind, value] = header.split(' ', 2);
	if (value === undefined) return undefined;
	if (kind?.toLowerCase() === 'bearer') return value;
	if (kind?.toLowerCase() !== 'basic') return undefined;
	const decoded = Buffer.from(value, 'base64').toString('utf8');
	const colon = decoded.indexOf(':');
	return colon < 0 ? undefined : decoded.slice(colon + 1);
}
