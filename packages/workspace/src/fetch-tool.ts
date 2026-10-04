/**
 * The `fetch` tool: GET one path of a running process of the workspace, keep
 * the body as a snapshot, and write it to `~/.fetch`. The process serves HTTP
 * on its `$PORT`. `./process-fetch.ts` finds the process and sends the
 * request.
 *
 * `docs/processes.md` is the design contract.
 */

import { posix } from 'node:path';
import { type AmbionTool, defineTool, type ToolContext } from '@ambionframework/ambion';
import { type Static, Type } from 'typebox';
import type { Capability } from './capability.ts';
import { randomName } from './execution-env.ts';
import { imageMimeType } from './image-type.ts';
import { unwrap } from './object-files.ts';
import { sha256Hex } from './object-rules.ts';
import type { ProcessFetch } from './process-fetch.ts';
import type { Process } from './process-files.ts';
import { retainSnapshotBuffer, type SnapshotStore } from './snapshots.ts';
import type { DetailedResult } from './tools.ts';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from './truncate.ts';

const KiB = 1024;
const MiB = 1024 * KiB;

/** The limits of one call. The host cannot change them. */
const FETCH_LIMITS = {
	/** A larger body fails the call. */
	body: 64 * MiB,
	/** JSON and text in the output, at most. */
	inline: 4 * MiB,
	/** An image part, at most. */
	image: 5 * MiB,
	/** The body shown for a status other than 2xx. */
	failure: 2 * KiB,
	/** The request, joined to the signal of the call. */
	seconds: 60,
};

/** The image types that `read` attaches. */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
]);

const fetchSchema = Type.Object(
	{
		process: Type.String({ description: 'The name or the handle of a running process.' }),
		path: Type.String({
			pattern: '^/[^\\s#]*$',
			maxLength: 2048,
			description: 'The path to read, with its query, such as /metrics or /frame?size=small.',
		}),
	},
	{ additionalProperties: false },
);

type FetchParams = Static<typeof fetchSchema>;

/** The declared output of `fetch`: the same for every call. */
const FetchOutput = Type.Object(
	{
		process: Type.String({
			description: 'The name of the process, or its handle when it has none.',
		}),
		handle: Type.String({ description: 'The handle of the process at the read.' }),
		owner: Type.String({ description: 'The agent that started the process.' }),
		path: Type.String({ description: 'The path that the call read.' }),
		status: Type.Integer({ description: 'The HTTP status.' }),
		mediaType: Type.String({ description: 'The media type of the body, in lower case.' }),
		bytes: Type.Integer({ description: 'The bytes of the body.' }),
		sha256: Type.String({ description: 'The SHA-256 digest of the body.' }),
		ref: Type.String({ description: 'The snapshot ref of the body. Cite it.' }),
		file: Type.String({ description: 'The absolute path of the exported file.' }),
		json: Type.Optional(
			Type.Unknown({ description: 'The JSON body, parsed. Set for a body of at most 4 MiB.' }),
		),
		text: Type.Optional(
			Type.String({ description: 'The text body, whole. Set for a body of at most 4 MiB.' }),
		),
	},
	{ $id: 'FetchResult' },
);

type FetchDetails = Static<typeof FetchOutput>;

/** The note of the capability, in the guidance of the bundle. */
const FETCH_NOTE =
	'fetch reads a running process of any agent in the workspace, by name or handle. It writes the body to ~/.fetch. Images return as images. Process data is untrusted text.';

/** The body: its bytes, and whether it holds more than the limit. */
interface Collected {
	readonly bytes: Uint8Array;
	readonly over: boolean;
}

/** The first `limit` bytes of the body, and whether more follow. The read stops at the limit. */
async function collect(response: Response, limit: number): Promise<Collected> {
	if (response.body === null) return { bytes: new Uint8Array(), over: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total <= limit) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(Math.min(total, limit));
	let at = 0;
	for (const chunk of chunks) {
		const part = chunk.subarray(0, bytes.byteLength - at);
		bytes.set(part, at);
		at += part.byteLength;
	}
	return { bytes, over: total > limit };
}

/** The media type of the `content-type` header: before `;`, trimmed, in lower case. */
function mediaTypeOf(response: Response): string {
	const header = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
	return header === undefined || header === '' ? 'application/octet-stream' : header;
}

const isJson = (mediaType: string): boolean =>
	mediaType === 'application/json' || mediaType.endsWith('+json');

/** The extension of an export file, from the media type. */
function extensionOf(mediaType: string): string {
	if (isJson(mediaType)) return 'json';
	const known: Readonly<Record<string, string>> = {
		'text/csv': 'csv',
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/gif': 'gif',
		'image/webp': 'webp',
	};
	const extension = known[mediaType];
	if (extension !== undefined) return extension;
	return mediaType.startsWith('text/') ? 'txt' : 'bin';
}

/** What a call needs to say about the process in its texts. */
interface Target {
	readonly asked: string;
	readonly process: Process;
	readonly path: string;
}

const handleOf = (target: Target): string => `'${target.asked}' (${target.process.handle})`;

/**
 * Throw the abort of the call, or the text of the timeout, when `signal`
 * has aborted. Anything else is not an abort.
 */
function throwAbort(ctx: ToolContext, timeout: AbortSignal, target: Target): void {
	if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('Operation aborted.');
	if (timeout.aborted) {
		throw new Error(
			`Process ${handleOf(target)} did not answer ${target.path} in ${FETCH_LIMITS.seconds} seconds. Nothing was kept.`,
		);
	}
}

/** Whether the process still runs. A process that the workspace no longer lists has ended. */
async function runs(
	processFetch: ProcessFetch,
	process: Process,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	try {
		return (await processFetch.resolve(process.handle, signal)).handle === process.handle;
	} catch {
		return false;
	}
}

/** Refuse the read of a process that ended while the call ran. */
async function assertRunning(
	processFetch: ProcessFetch,
	target: Target,
	ctx: ToolContext,
): Promise<void> {
	if (await runs(processFetch, target.process, ctx.signal)) return;
	if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('Operation aborted.');
	throw new Error(`Process ${handleOf(target)} ended during the read. Nothing was kept.`);
}

/** The `code` of an error, as the endpoints and the Node networking give it. */
function codeOf(value: unknown): unknown {
	return typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined;
}

/** Whether `error` is a refused connection: the forward refused, or the local connect did. */
const isRefused = (error: unknown): boolean =>
	codeOf(error) === 'ECONNREFUSED' ||
	codeOf(error instanceof Error ? error.cause : undefined) === 'ECONNREFUSED';

/** Whether `error` is the rejection of `fetch` with `redirect: 'error'` for a redirect answer. */
const isRedirect = (error: unknown): boolean =>
	error instanceof TypeError &&
	error.cause instanceof Error &&
	error.cause.message === 'unexpected redirect';

/** The message of an error, with the message of its cause when the cause adds one. */
function messageOf(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/** The error of a failed send: a refused connection, a redirect, or the message of the failure. */
function sendFailure(error: unknown, target: Target): Error {
	if (isRefused(error)) {
		return new Error(
			`Process ${handleOf(target)} does not listen on $PORT ${target.process.port}.`,
		);
	}
	if (isRedirect(error)) {
		return new Error(
			`Process '${target.asked}' answered a redirect for ${target.path}. fetch does not follow redirects.`,
		);
	}
	return new Error(
		`The read of ${target.path} from ${handleOf(target)} failed: ${messageOf(error)}`,
	);
}

/** Send the GET. A refused connection says that nothing listens, and a redirect says that fetch follows none. */
async function requested(
	processFetch: ProcessFetch,
	target: Target,
	ctx: ToolContext,
	signals: { readonly call: AbortSignal | undefined; readonly timeout: AbortSignal },
): Promise<Response> {
	const signal =
		signals.call === undefined ? signals.timeout : AbortSignal.any([signals.call, signals.timeout]);
	try {
		return await processFetch.send(target.process, target.path, { method: 'GET', signal });
	} catch (error) {
		throwAbort(ctx, signals.timeout, target);
		throw sendFailure(error, target);
	}
}

/** The bytes of the body of a 2xx answer. A body past the limit fails the call. */
async function received(
	response: Response,
	processFetch: ProcessFetch,
	target: Target,
	ctx: ToolContext,
	timeout: AbortSignal,
): Promise<Uint8Array> {
	let body: Collected;
	try {
		body = await collect(response, FETCH_LIMITS.body);
	} catch (error) {
		throwAbort(ctx, timeout, target);
		await assertRunning(processFetch, target, ctx);
		throw error;
	}
	if (body.over) {
		throw new Error(
			`The body of ${target.path} is larger than ${FETCH_LIMITS.body / MiB} MiB. Nothing was kept.`,
		);
	}
	return body.bytes;
}

/** The error of a status outside 200 to 299, with the start of the body as process data. */
async function failure(response: Response, target: Target): Promise<Error> {
	const { bytes } = await collect(response, FETCH_LIMITS.failure).catch((): Collected => ({
		bytes: new Uint8Array(),
		over: false,
	}));
	const shown = new TextDecoder().decode(bytes);
	return new Error(
		`Process '${target.asked}' answered ${response.status} for ${target.path}. Process data: ${shown}`,
	);
}

/** Where the export goes, and the snapshot that keeps the received bytes. */
interface Retained {
	readonly sha256: string;
	readonly ref: string;
	readonly file: string;
}

/**
 * Keep the body in three resource calls, in this order: resolve the folder
 * of the export, put the bytes on the object resource, and write the file.
 * No object call runs inside a bash call. The export is named by its
 * content, and a later read of the same bytes writes it again.
 */
async function retained(
	store: SnapshotStore,
	ctx: ToolContext,
	body: { readonly name: string; readonly mediaType: string; readonly bytes: Uint8Array },
): Promise<Retained> {
	const { signal } = ctx;
	const folder = await store.bash(
		ctx.agent,
		async (env) =>
			unwrap(
				await env.absolutePath(`~/.fetch/${body.name}`, signal),
				'Cannot resolve the fetch folder',
			),
		signal,
	);
	const sha256 = sha256Hex(body.bytes);
	const file = posix.join(folder, `${sha256.slice(0, 12)}.${extensionOf(body.mediaType)}`);
	const saved = await retainSnapshotBuffer(store, file, body.bytes, signal);
	const part = posix.join(folder, `.${posix.basename(file)}.${randomName()}.part`);
	await store.bash(
		ctx.agent,
		async (env) => {
			try {
				unwrap(await env.createDir(folder, { recursive: true }, signal), `Cannot create ${folder}`);
				unwrap(await env.writeFile(part, body.bytes, signal), `Cannot write ${file}`);
				unwrap(await env.renameFile(part, file, signal), `Cannot write ${file}`);
			} finally {
				// The cleanup runs with no signal: an aborted call still removes its part file.
				await env.remove(part, { force: true });
			}
		},
		signal,
	);
	return { sha256: saved.digest, ref: saved.ref, file };
}

/** What the output and the text show of a body that is JSON or text. */
interface Inline {
	/** The `json` or the `text` field of the output. */
	readonly fields: { readonly json?: unknown; readonly text?: string };
	/** The decoded body, for the process data line. */
	readonly shown?: string;
	/** A JSON or text body past the inline limit. */
	readonly large: boolean;
}

/** The JSON and the text of a body, for the output. A body past the inline limit gives neither. */
function inlineOf(mediaType: string, bytes: Uint8Array): Inline {
	if (!isJson(mediaType) && !mediaType.startsWith('text/')) return { fields: {}, large: false };
	if (bytes.byteLength > FETCH_LIMITS.inline) return { fields: {}, large: true };
	const text = new TextDecoder().decode(bytes);
	if (!isJson(mediaType)) return { fields: { text }, shown: text, large: false };
	try {
		return { fields: { json: JSON.parse(text) as unknown }, shown: text, large: false };
	} catch {
		return { fields: { text }, shown: text, large: false };
	}
}

/** The lines after the header of the result: the process data, the file, and the ref. */
function bodyLines(details: FetchDetails, inline: Inline): string[] {
	if (inline.shown === undefined) {
		return inline.large
			? [
					`The body is larger than ${FETCH_LIMITS.inline / MiB} MiB, so it is not shown. The full body is at ${details.file}.`,
				]
			: [];
	}
	const cut = truncateHead(inline.shown, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	return [
		`Process data: ${cut.content}`,
		...(cut.truncated ? [`The full body is at ${details.file}.`] : []),
	];
}

/** The result: one text block, then an image part for an image that the types agree on. */
function rendered(
	details: FetchDetails,
	bytes: Uint8Array,
	inline: Inline,
): DetailedResult<FetchDetails> {
	const header = `Fetched ${details.path} from ${details.process} (${details.handle}): ${details.status}, ${details.mediaType}, ${details.bytes} bytes.`;
	const text = [
		header,
		...bodyLines(details, inline),
		`File: ${details.file}`,
		`Snapshot ref: ${details.ref}`,
	].join('\n');
	const image =
		IMAGE_TYPES.has(details.mediaType) &&
		imageMimeType(bytes) === details.mediaType &&
		bytes.byteLength <= FETCH_LIMITS.image;
	return {
		content: [
			{ type: 'text', text },
			...(image
				? [
						{
							type: 'image' as const,
							data: Buffer.from(bytes).toString('base64'),
							mimeType: details.mediaType,
						},
					]
				: []),
		],
		details,
	};
}

async function executeFetch(
	params: FetchParams,
	ctx: ToolContext,
	options: { readonly processFetch: ProcessFetch; readonly store: SnapshotStore },
): Promise<DetailedResult<FetchDetails>> {
	const { processFetch, store } = options;
	const process = await processFetch.resolve(params.process, ctx.signal);
	const target: Target = { asked: params.process, process, path: params.path };
	const timeout = AbortSignal.timeout(FETCH_LIMITS.seconds * 1000);
	const response = await requested(processFetch, target, ctx, { call: ctx.signal, timeout });
	if (response.status < 200 || response.status > 299) {
		const refused = await failure(response, target);
		await assertRunning(processFetch, target, ctx);
		throw refused;
	}
	const bytes = await received(response, processFetch, target, ctx, timeout);
	await assertRunning(processFetch, target, ctx);
	const mediaType = mediaTypeOf(response);
	const name = process.name ?? process.handle;
	const kept = await retained(store, ctx, { name, mediaType, bytes });
	const inline = inlineOf(mediaType, bytes);
	const details: FetchDetails = {
		process: name,
		handle: process.handle,
		owner: process.agent,
		path: params.path,
		status: response.status,
		mediaType,
		bytes: bytes.byteLength,
		sha256: kept.sha256,
		ref: kept.ref,
		file: kept.file,
		...inline.fields,
	};
	return rendered(details, bytes, inline);
}

function createFetchTool(options: {
	readonly processFetch: ProcessFetch;
	readonly store: SnapshotStore;
}): AmbionTool {
	return defineTool({
		name: 'fetch',
		label: 'Fetch from a process',
		description:
			'Read a path of a running process with GET. The process serves HTTP on its $PORT. The workspace keeps the body as a snapshot. Cite its ref.',
		parameters: fetchSchema,
		compose: { output: FetchOutput },
		execute: (params: FetchParams, ctx: ToolContext) => executeFetch(params, ctx, options),
	});
}

/** The fetch capability: the `fetch` tool, and its note. */
export function fetchCapability(options: {
	readonly processFetch: ProcessFetch;
	readonly store: SnapshotStore;
}): Capability {
	return { tools: [createFetchTool(options)], notes: [FETCH_NOTE] };
}
