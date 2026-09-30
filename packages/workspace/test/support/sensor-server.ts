import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileBytes, fileDigest, frameBytes, frameDigest } from './sensor-blobs.ts';

const span = { from: '2026-09-29T10:00:00.000Z', to: '2026-09-29T10:00:03.000Z' } as const;
const early = {
	parts: [
		{
			kind: 'series',
			channel: 'voltage',
			unit: 'V',
			from: '2026-09-29T09:59:58.000Z',
			intervalMs: 1000,
			values: [4.98, 4.99],
		},
	],
	at: '2026-09-29T09:59:59.000Z',
};
const within = {
	at: '2026-09-29T10:00:01.000Z',
	parts: [
		{
			kind: 'series',
			channel: 'voltage',
			unit: 'V',
			from: span.from,
			intervalMs: 1000,
			values: [5, 5.01, 5.02],
		},
		{ kind: 'text', text: 'Supply stable at 5 V.' },
		{ kind: 'frame', file: frameDigest, mediaType: 'image/png' },
		{ kind: 'file', file: fileDigest, name: 'reading.csv', mediaType: 'text/csv' },
	],
};
const allObservations = [early, within];

export type SensorDefect =
	| 'version'
	| 'observation-version'
	| 'digest'
	| 'span'
	| 'sample'
	| 'name'
	| 'unsupported-span'
	| 'unavailable-span'
	| 'dirty-source';

export interface SensorServerOptions {
	/** Wait at the request boundary so tests can cancel or exercise other tools. */
	readonly beforeObserve?: (body: Record<string, unknown>) => Promise<void>;
	/** Wait at a file boundary so tests can cancel before retention starts. */
	readonly beforeFile?: (digest: string) => Promise<void>;
}

export async function startSensorServer(
	defect?: SensorDefect,
	options: SensorServerOptions = {},
): Promise<{
	origin: string;
	readonly observeCalls: number;
	close(): Promise<void>;
}> {
	let observeCalls = 0;
	let server: Server;
	server = createServer(
		(request, response) => void route(request, response, defect, options, () => observeCalls++),
	);
	await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
	const address = server.address();
	if (!address || typeof address === 'string')
		throw new Error('Sensor fixture did not bind a TCP port.');
	return {
		origin: `http://127.0.0.1:${address.port}`,
		get observeCalls() {
			return observeCalls;
		},
		async close() {
			await new Promise<void>((resolveClose, reject) => {
				server.close((error) => (error ? reject(error) : resolveClose()));
			});
		},
	};
}

async function route(
	request: IncomingMessage,
	response: ServerResponse,
	defect: SensorDefect | undefined,
	options: SensorServerOptions,
	countObserve: () => void,
) {
	const url = new URL(request.url ?? '/', 'http://localhost');
	if (request.method === 'GET' && url.pathname === '/') return sendIndex(response, defect);
	if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
		await options.beforeFile?.(url.pathname.slice('/files/'.length));
		return sendFile(response, url.pathname, defect);
	}
	if (request.method === 'POST' && url.pathname === '/bench/observe') {
		countObserve();
		return sendObservation(request, response, defect, options.beforeObserve);
	}
	if (request.method === 'POST' && /\/observe$/.test(url.pathname)) {
		return sendError(response, 404, 'unknown', 'Unknown sensor.');
	}
	return sendError(response, 404, 'unknown', 'Unknown path.');
}

function sendIndex(response: ServerResponse, defect?: SensorDefect) {
	const index = {
		api: defect === 'version' ? 2 : 1,
		source: {
			repository: 'tests/sensor-fixture',
			commit: 'a'.repeat(40),
			dirty: defect === 'dirty-source',
		},
		sensors: [
			{
				name: defect === 'name' ? 'wrong-name' : 'bench',
				description: 'Bench fixture.',
				spans: defect !== 'unsupported-span',
			},
		],
	};
	return json(response, 200, index);
}

function sendFile(response: ServerResponse, path: string, defect?: SensorDefect) {
	const target = path.endsWith(frameDigest)
		? { bytes: frameBytes, mediaType: 'image/png' }
		: path.endsWith(fileDigest)
			? { bytes: fileBytes, mediaType: 'text/csv' }
			: undefined;
	if (!target) return sendError(response, 404, 'unknown', 'Unknown file.');
	const bytes = defect === 'digest' ? Buffer.from('wrong file bytes') : target.bytes;
	response.writeHead(200, { 'content-type': target.mediaType });
	return response.end(bytes);
}

async function sendObservation(
	request: IncomingMessage,
	response: ServerResponse,
	defect?: SensorDefect,
	beforeObserve?: SensorServerOptions['beforeObserve'],
) {
	const body = await readJson(request);
	if (body.api !== 1) return sendError(response, 400, 'invalid', 'Wrong API.');
	await beforeObserve?.(body);
	if (isInvalidSpan(body))
		return sendError(response, 400, 'invalid', 'The span is empty or reversed.');
	if (body.span && defect === 'unsupported-span')
		return json(response, 200, { api: 1, observations: [within] });
	if (body.span && defect === 'unavailable-span')
		return sendError(response, 422, 'unavailable', 'This fixture cannot serve the requested span.');
	if (body.span && defect === 'span')
		return json(response, 200, { api: 1, observations: [{ ...within, at: span.to }] });
	if (body.span && defect === 'sample') return sendBadSamples(response);
	return json(response, 200, {
		observations: body.span ? [within] : allObservations,
		api: defect === 'observation-version' ? 2 : 1,
	});
}

function isInvalidSpan(body: Record<string, unknown>): boolean {
	if (!body.span || typeof body.span !== 'object') return false;
	const value = body.span as { from?: unknown; to?: unknown };
	return typeof value.from === 'string' && typeof value.to === 'string' && value.from >= value.to;
}

function sendBadSamples(response: ServerResponse) {
	const [series, ...parts] = within.parts;
	return json(response, 200, {
		api: 1,
		observations: [{ ...within, parts: [{ ...series, from: span.to }, ...parts] }],
	});
}

function sendError(response: ServerResponse, status: number, code: string, message: string) {
	return json(response, status, { api: 1, code, message });
}

function json(response: ServerResponse, status: number, value: unknown) {
	response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	response.end(JSON.stringify(value));
}

function readJson(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let raw = '';
		request.setEncoding('utf8');
		request.on('data', (part: string) => (raw += part));
		request.on('end', () => {
			try {
				resolve(JSON.parse(raw) as Record<string, unknown>);
			} catch (error) {
				reject(error);
			}
		});
		request.on('error', reject);
	});
}
