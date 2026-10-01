/**
 * The rules every object backend applies. They are the limits of S3, which
 * R2 and MinIO hold too, so a store of any kind takes what S3 takes. The
 * workspace and each backend import them from here, so each rule has one
 * home. A bash backend sets none of them.
 */

import { createHash } from 'node:crypto';
import { formatBytes } from './format-bytes.ts';

/**
 * The most bytes one object holds: 5 GiB, the limit of one S3 PutObject.
 * The ports pass whole buffers and no backend makes a multipart upload, so
 * an object is one put.
 */
export const MAX_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;

/** The SHA-256 digest of `bytes`, as 64 lowercase hex digits. */
export function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** The most UTF-8 bytes one S3 key holds: the prefix and the digest together. */
const MAX_KEY_BYTES = 1024;

// The kernel's snapshot URI holds the same digest. A backend checks its own
// key, since host code can call `put` and `get` without a ref.
const DIGEST = /^[0-9a-f]{64}$/;

/** The characters S3 calls safe in a key. The URL of an object then needs no encoding. */
const SAFE_PREFIX = /^[A-Za-z0-9!\-_.*'()/]*$/;

/** Throw a `RangeError` when `digest` is not 64 lowercase hex digits. */
export function assertDigest(digest: string): void {
	if (!DIGEST.test(digest))
		throw new RangeError(`An object key is 64 lowercase hex digits of SHA-256: '${digest}'.`);
}

/** Throw when `what`, of `bytes` bytes, is larger than one object holds. */
export function assertObjectSize(what: string, bytes: number): void {
	if (bytes > MAX_OBJECT_BYTES)
		throw new Error(
			`${what} holds ${formatBytes(bytes)}, more than the ${formatBytes(MAX_OBJECT_BYTES)} that an object holds.`,
		);
}

/** Throw a `RangeError` when a key of `prefix` and a digest is longer than S3 takes. */
export function assertPrefix(prefix: string): void {
	if (!SAFE_PREFIX.test(prefix))
		throw new RangeError(
			`A key prefix holds only the characters S3 calls safe, A-Z a-z 0-9 ! - _ . * ' ( ) and /: '${prefix}'.`,
		);
	const bytes = Buffer.byteLength(prefix) + 64;
	if (bytes > MAX_KEY_BYTES)
		throw new RangeError(
			`A key of the prefix and a digest holds ${bytes} bytes, and S3 takes at most ${MAX_KEY_BYTES}.`,
		);
}
