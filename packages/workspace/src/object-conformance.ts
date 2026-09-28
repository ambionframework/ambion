/**
 * The cases every object backend (`ObjectBackend`) must pass.
 *
 * A harness opens a store and gives the backend over it. A case writes and
 * reads through `connect`, as more than one agent, and checks what the
 * contract states. A harness that can open the same store again gives
 * `reopen`, and one more case checks that the bytes outlast `dispose`.
 *
 * ```ts
 * describe.each(harnesses)('$name', (harness) => {
 * 	for (const c of objectConformance(harness)) it(c.name, c.run);
 * });
 * ```
 */

import { createHash } from 'node:crypto';
import type { ConformanceCase } from '@ambionframework/ambion/conformance';
import type { ObjectBackend, ObjectEnv } from './object-backend.ts';

/** One store under test. `reopen` opens a second backend over the same store. */
export interface ObjectConformanceStore {
	readonly backend: ObjectBackend;
	reopen?(): Promise<ObjectBackend>;
	dispose(): Promise<void>;
}

/** A store factory. `open` runs inside every case, so each case gets a fresh store. */
export interface ObjectConformanceBackend {
	readonly name: string;
	open(): Promise<ObjectConformanceStore>;
}

function check(condition: boolean, what: string): void {
	if (!condition) throw new Error(what);
}

const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const same = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
	a !== undefined && Buffer.from(a).equals(Buffer.from(b));

/** Run `body` over one env of `backend` as `agent`, and clean the env up after. */
async function withEnv<T>(
	backend: ObjectBackend,
	agent: string,
	body: (env: ObjectEnv) => Promise<T>,
): Promise<T> {
	const env = await backend.connect({ name: agent });
	try {
		return await body(env);
	} finally {
		await env.cleanup();
	}
}

/** Put `bytes` as the host and give its digest. */
async function put(backend: ObjectBackend, bytes: Uint8Array): Promise<string> {
	const digest = digestOf(bytes);
	await withEnv(backend, 'host', (env) => env.put(digest, bytes));
	return digest;
}

type Body = (store: ObjectConformanceStore) => Promise<void>;

const roundTrips: Body = async ({ backend }) => {
	const cases = [
		new Uint8Array([7]),
		new Uint8Array([0, 1, 0, 255, 0]),
		new Uint8Array(0),
		new Uint8Array(1024 * 1024).map((_, index) => index % 251),
	];
	for (const bytes of cases) {
		const digest = await put(backend, bytes);
		const got = await withEnv(backend, 'host', (env) => env.get(digest));
		check(same(got, bytes), `get did not give the ${bytes.byteLength} bytes back`);
	}
};

const unknownIsUndefined: Body = async ({ backend }) => {
	const got = await withEnv(backend, 'host', (env) => env.get(digestOf(new Uint8Array([1, 2]))));
	check(got === undefined, 'get of an unknown digest gave bytes');
};

const secondPutKeepsBytes: Body = async ({ backend }) => {
	const bytes = new TextEncoder().encode('pour on Thursday\n');
	const digest = await put(backend, bytes);
	await withEnv(backend, 'host', (env) => env.put(digest, bytes));
	// Two puts of a new digest at once: both succeed, whichever lands first.
	const twin = new TextEncoder().encode('twin\n');
	await Promise.all([put(backend, twin), put(backend, twin)]);
	const both = await withEnv(backend, 'host', (env) => env.get(digestOf(twin)));
	check(same(both, twin), 'two puts at once lost the bytes');
	const got = await withEnv(backend, 'host', (env) => env.get(digest));
	check(same(got, bytes), 'a second put lost the bytes');
};

const oneStoreForEveryAgent: Body = async ({ backend }) => {
	const bytes = new TextEncoder().encode('shared\n');
	const digest = await put(backend, bytes);
	const got = await withEnv(backend, 'reviewer', (env) => env.get(digest));
	check(same(got, bytes), 'another agent did not get the bytes the host put');
};

const badDigestIsRefused: Body = async ({ backend }) => {
	const refused = async (operation: (env: ObjectEnv) => Promise<unknown>) =>
		withEnv(backend, 'host', operation).then(
			() => false,
			(error: unknown) => error instanceof RangeError,
		);
	for (const digest of ['abc', 'A'.repeat(64), `${'a'.repeat(63)}/`, '../x']) {
		check(await refused((env) => env.put(digest, new Uint8Array([1]))), `put took ${digest}`);
		check(await refused((env) => env.get(digest)), `get took ${digest}`);
	}
};

const abortedPutStoresNothing: Body = async ({ backend }) => {
	const bytes = new TextEncoder().encode('never\n');
	const digest = digestOf(bytes);
	const controller = new AbortController();
	controller.abort();
	const rejected = await withEnv(backend, 'host', (env) =>
		env.put(digest, bytes, controller.signal),
	).then(
		() => false,
		() => true,
	);
	check(rejected, 'an aborted put did not reject');
	const got = await withEnv(backend, 'host', (env) => env.get(digest));
	check(got === undefined, 'an aborted put stored the bytes');
};

const bytesOutlastDispose: Body = async (store) => {
	if (store.reopen === undefined) return;
	const bytes = new TextEncoder().encode('kept\n');
	const digest = await put(store.backend, bytes);
	await store.backend.dispose?.();
	const again = await store.reopen();
	const got = await withEnv(again, 'host', (env) => env.get(digest));
	await again.dispose?.();
	check(same(got, bytes), 'the bytes did not outlast dispose');
};

const CASES: readonly [string, Body][] = [
	['put then get gives the same bytes, empty and 1 MiB included', roundTrips],
	['get of an unknown digest gives undefined', unknownIsUndefined],
	[
		'a second put of one digest succeeds and keeps the bytes, also two at once',
		secondPutKeepsBytes,
	],
	['every agent reaches one store', oneStoreForEveryAgent],
	['put and get refuse a key that is not a SHA-256 digest', badDigestIsRefused],
	['a put with an aborted signal rejects and stores nothing', abortedPutStoresNothing],
	['the bytes outlast dispose, when the store can open again', bytesOutlastDispose],
];

/** The cases of an object backend, as named test bodies. */
export function objectConformance(harness: ObjectConformanceBackend): readonly ConformanceCase[] {
	return CASES.map(([name, body]) => ({
		name,
		run: async () => {
			const store = await harness.open();
			try {
				await body(store);
			} finally {
				await store.dispose();
			}
		},
	}));
}
