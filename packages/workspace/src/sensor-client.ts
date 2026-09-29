/** The small HTTP client for the versioned sensor wire protocol. */
import { createHash } from 'node:crypto';
import type { TSchema } from 'typebox';
import { Check } from 'typebox/value';
import {
	ObserveResponseSchema,
	SensorErrorSchema,
	SensorIndexSchema,
	isValidObserveRequest,
	type ObserveRequest,
	type ObserveResponse,
	type SensorError,
	type SensorIndex,
} from './sensors.ts';

/** An HTTP response that reports a valid sensor error envelope. */
export class SensorHttpError extends Error {
	readonly status: number;
	readonly sensorError: SensorError;

	constructor(status: number, sensorError: SensorError) {
		super(`Sensor server returned HTTP ${status}: ${sensorError.code}: ${sensorError.message}`);
		this.name = 'SensorHttpError';
		this.status = status;
		this.sensorError = sensorError;
	}
}

/** A response or input that does not follow the sensor wire protocol. */
export class SensorProtocolError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number, options?: ErrorOptions) {
		super(message, options);
		this.name = 'SensorProtocolError';
		this.status = status;
	}
}

/** File bytes whose content does not match the digest in their URL. */
export class SensorDigestError extends Error {
	readonly expected: string;
	readonly actual: string;

	constructor(expected: string, actual: string) {
		super(`Sensor file digest mismatch: expected ${expected}, received ${actual}.`);
		this.name = 'SensorDigestError';
		this.expected = expected;
		this.actual = actual;
	}
}

/** The verified bytes returned by a sensor file request. */
export interface SensorFile {
	readonly bytes: Uint8Array;
	readonly mediaType: string;
}

/** The three read operations supported by sensor API version 1. */
export interface SensorClient {
	index(signal?: AbortSignal): Promise<SensorIndex>;
	observe(name: string, request?: ObserveRequest, signal?: AbortSignal): Promise<ObserveResponse>;
	file(digest: string, signal?: AbortSignal): Promise<SensorFile>;
}

/** Create a client rooted at a private HTTP transport URL. */
export function createSensorClient(root: string): SensorClient {
	const base = transportBase(root);

	return {
		async index(signal) {
			const response = await get(new URL('./', base), signal);
			return readJson(response, SensorIndexSchema, 'sensor index');
		},
		async observe(name, request = { api: 1 }, signal) {
			if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*(?![\s\S])/.test(name))
				throw new SensorProtocolError(`Invalid sensor name: ${JSON.stringify(name)}.`);
			if (!isValidObserveRequest(request))
				throw new SensorProtocolError('The observe request fails the sensor API version 1 schema.');
			const response = await fetch(new URL(`${encodeURIComponent(name)}/observe`, base), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(request),
				signal,
				redirect: 'error',
			});
			return readJson(response, ObserveResponseSchema, 'observation response');
		},
		async file(digest, signal) {
			if (typeof digest !== 'string' || !/^[0-9a-f]{64}(?![\s\S])/.test(digest))
				throw new SensorProtocolError(`Invalid SHA-256 digest: ${JSON.stringify(digest)}.`);
			const response = await get(new URL(`files/${digest}`, base), signal);
			const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
			if (!mediaType) {
				await response.body?.cancel();
				throw new SensorProtocolError('The file response has no media type.', response.status);
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			const actual = createHash('sha256').update(bytes).digest('hex');
			if (actual !== digest) throw new SensorDigestError(digest, actual);
			return { bytes, mediaType };
		},
	};
}

function transportBase(root: string): URL {
	let url: URL;
	try {
		url = new URL(root);
	} catch (cause) {
		throw new TypeError('The sensor transport root must be an absolute HTTP URL.', { cause });
	}
	if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.search || url.hash)
		throw new TypeError(
			'The sensor transport root must be an HTTP URL without a query or fragment.',
		);
	url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
	return url;
}

async function get(url: URL, signal?: AbortSignal): Promise<Response> {
	const response = await fetch(url, { signal, redirect: 'error' });
	if (!response.ok) await throwHttpError(response);
	return response;
}

async function readJson<T>(response: Response, schema: TSchema, label: string): Promise<T> {
	if (!response.ok) await throwHttpError(response);
	const text = await response.text();
	const body = parseJson(text, label, response.status);
	if (!Check(schema, body))
		throw new SensorProtocolError(
			`The ${label} fails the sensor API version 1 schema.`,
			response.status,
		);
	return body as T;
}

async function throwHttpError(response: Response): Promise<never> {
	const text = await response.text();
	const body = parseJson(text, 'sensor error envelope', response.status);
	if (!Check(SensorErrorSchema, body))
		throw new SensorProtocolError(
			`HTTP ${response.status} returned an invalid sensor error envelope.`,
			response.status,
		);
	throw new SensorHttpError(response.status, body as SensorError);
}

function parseJson(text: string, label: string, status: number): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (cause) {
		throw new SensorProtocolError(`The ${label} is not valid JSON.`, status, { cause });
	}
}
