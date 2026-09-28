/**
 * An object backend over an S3 API: Amazon S3, Cloudflare R2, or MinIO.
 *
 * `aws4fetch` signs each request with SigV4 over the global `fetch`. The
 * key of an object is `<prefix><digest>`. A put reads the head first, and
 * writes nothing when the object exists. Otherwise it sends the bytes with
 * `If-None-Match: *`, so the store never rewrites an object, and a 412
 * means that a concurrent put stored the same bytes first. A 409 means that
 * a concurrent put is still in progress, so the put reads the head again and
 * sends the bytes again. The put also sends `x-amz-checksum-sha256`, so the
 * store refuses bytes that changed on the way. The workspace checks the
 * digest of every object it reads.
 *
 * S3 gives 403 for a missing object when the credential has no
 * `s3:ListBucket`. A put then sends the bytes, and the conditional put
 * decides. A get gives the 403 as an error, so grant `s3:ListBucket` for a
 * clear answer about a missing object.
 *
 * The host holds the credentials. No agent reaches the store: `fetch` reads
 * an object on the object owner and writes it into the agent's files.
 */

import { AwsClient } from 'aws4fetch';
import type { ObjectBackend, ObjectEnv } from './object-backend.ts';
import { assertDigest, assertObjectSize, assertPrefix } from './object-rules.ts';

/** Where the store is, and the credential of the host. */
export interface S3ObjectBackendOptions {
	/** The URL of the S3 API, such as `http://127.0.0.1:9000` for MinIO. */
	readonly endpoint: string;
	/** The region: `us-east-1` for MinIO, `auto` for R2. */
	readonly region: string;
	readonly bucket: string;
	/**
	 * A key prefix, such as `snapshots/`, so one bucket serves more than one
	 * workspace. With the digest, a key holds at most 1024 bytes, as S3 takes.
	 */
	readonly prefix?: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken?: string;
	/** Put the bucket in the path. The default is `true`, which MinIO needs. */
	readonly pathStyle?: boolean;
	/** How many times a request that failed with a 5xx or a 429 runs again. The default is 2. */
	readonly retries?: number;
}

/** The URL of the object store: the bucket and the prefix. */
function storeUrl(options: S3ObjectBackendOptions): string {
	const endpoint = new URL(options.endpoint);
	const base = endpoint.href.replace(/\/$/, '');
	const bucket = encodeURIComponent(options.bucket);
	if (options.pathStyle ?? true) return `${base}/${bucket}/`;
	return `${endpoint.protocol}//${bucket}.${endpoint.host}${endpoint.pathname.replace(/\/?$/, '/')}`;
}

/** How many times a put sends the bytes while a concurrent put of the same key is in progress. */
const CONFLICT_ATTEMPTS = 3;

/** Throw when `length` is past the object limit, and release the body first. */
async function sizedOrCancel(response: Response, url: string, length: number): Promise<void> {
	try {
		assertObjectSize(url, length);
	} catch (error) {
		await response.body?.cancel();
		throw error;
	}
}

/** A put that stored the bytes, or found that a concurrent put stored them first. */
const stored = (response: Response): boolean => response.ok || response.status === 412;

/** The base64 of the SHA-256 whose hex is `digest`, as S3 checksums state it. */
const base64Of = (digest: string): string => Buffer.from(digest, 'hex').toString('base64');

/** The error of a response that is not the status the caller expected. */
async function failure(response: Response, what: string): Promise<Error> {
	const text = await response.text().catch(() => '');
	const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
	const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1];
	const detail = [code, message].filter(Boolean).join(': ');
	return new Error(`${what} failed with ${response.status}${detail ? ` (${detail})` : ''}.`);
}

/** An object backend over the S3 API. Every agent reaches one bucket. */
export function s3ObjectBackend(options: S3ObjectBackendOptions): ObjectBackend {
	assertPrefix(options.prefix ?? '');
	const client = new AwsClient({
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
		service: 's3',
		region: options.region,
		retries: options.retries ?? 2,
	});
	const store = `${storeUrl(options)}${options.prefix ?? ''}`;
	const urlOf = (digest: string): string => `${store}${digest}`;

	const exists = async (digest: string, signal?: AbortSignal): Promise<boolean> => {
		const response = await client.fetch(urlOf(digest), { method: 'HEAD', signal });
		if (!response.ok && response.status !== 404 && response.status !== 403)
			throw await failure(response, `The head of ${urlOf(digest)}`);
		await response.body?.cancel();
		// A 403 is a missing object for a credential without s3:ListBucket.
		return response.ok;
	};

	/** Send the bytes, on the condition that no object has the key. */
	const putIfAbsent = (digest: string, bytes: Uint8Array, signal?: AbortSignal) =>
		client.fetch(urlOf(digest), {
			method: 'PUT',
			body: bytes,
			signal,
			headers: {
				'content-type': 'application/octet-stream',
				'if-none-match': '*',
				'x-amz-content-sha256': digest,
				'x-amz-checksum-sha256': base64Of(digest),
			},
		});

	/** One head and one conditional put. Give the response that refused, or `undefined`. */
	const putOnce = async (
		digest: string,
		bytes: Uint8Array,
		signal?: AbortSignal,
	): Promise<Response | undefined> => {
		if (await exists(digest, signal)) return undefined;
		const response = await putIfAbsent(digest, bytes, signal);
		if (!stored(response)) return response;
		// Read nothing more, so the connection goes back to the pool.
		await response.body?.cancel();
		return undefined;
	};

	/**
	 * Put the bytes unless the store holds them. A 409 is a concurrent put in
	 * progress, so the head is read again. Give the response that refused, or
	 * `undefined` when the store holds the bytes.
	 */
	const putUnlessHeld = async (
		digest: string,
		bytes: Uint8Array,
		signal?: AbortSignal,
	): Promise<Response | undefined> => {
		for (let attempt = 1; ; attempt += 1) {
			const refused = await putOnce(digest, bytes, signal);
			if (refused?.status !== 409 || attempt === CONFLICT_ATTEMPTS) return refused;
			await refused.body?.cancel();
		}
	};

	const env: ObjectEnv = {
		put: async (digest, bytes, signal) => {
			assertDigest(digest);
			assertObjectSize(digest, bytes.byteLength);
			signal?.throwIfAborted();
			const refused = await putUnlessHeld(digest, bytes, signal);
			if (refused) throw await failure(refused, `The put of ${urlOf(digest)}`);
		},
		get: async (digest, signal) => {
			assertDigest(digest);
			const response = await client.fetch(urlOf(digest), { method: 'GET', signal });
			if (response.status === 404) {
				await response.body?.cancel();
				return undefined;
			}
			if (!response.ok) throw await failure(response, `The get of ${urlOf(digest)}`);
			// Refuse an object past the limit before its bytes enter memory.
			const length = Number(response.headers.get('content-length') ?? '0');
			if (length > 0) await sizedOrCancel(response, urlOf(digest), length);
			const bytes = new Uint8Array(await response.arrayBuffer());
			assertObjectSize(urlOf(digest), bytes.byteLength);
			return bytes;
		},
		cleanup: async () => undefined,
	};
	return Object.freeze({ store, connect: async () => env });
}
