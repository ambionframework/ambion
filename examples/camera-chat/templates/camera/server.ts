import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Frame } from './frame.ts';

// The wire contract of this server, protocol version 2.
//
//   GET /                          the index: api, source, sensors
//   GET /camera/observe[?from=&to=]  the latest frame; a span is not supported
//   GET /files/<sha256>            PNG bytes of a buffered frame
//
// A breaking change raises `API`. The `observe` macro of this template
// refuses a server at another `API`. A timestamp is UTC with three
// millisecond digits. An error body is `{ api, code, message }`, with a code
// of `invalid`, `unknown`, or `unavailable`.

/** The protocol version. */
export const API = 2;

/** The launch source that the index reports. */
export interface SensorSource {
	readonly repository: string;
	readonly commit: string;
	readonly branch?: string | undefined;
	readonly dirty: boolean;
}

/** The sensor that the index lists. */
export const SENSOR = 'camera';

function json(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

/** Host the version 2 API on `port` of the loopback. Keep recent frame bytes immutable. */
export async function openSensor(source: SensorSource, port = 0) {
	let latest: Frame | undefined;
	let failure: string | undefined;
	const frames = new Map<string, Buffer>();
	function sendFile(response: ServerResponse, path: string) {
		const png = frames.get(path.slice(7));
		if (!png)
			return json(response, 404, {
				api: API,
				code: 'unknown',
				message: 'The frame is no longer buffered.',
			});
		response.writeHead(200, { 'content-type': 'image/png' });
		response.end(png);
	}
	function observe(response: ServerResponse, query: URLSearchParams) {
		if (!validQuery(query))
			return json(response, 400, {
				api: API,
				code: 'invalid',
				message: 'The query is empty, or holds one from and one to that make a span.',
			});
		if (query.size > 0)
			return json(response, 422, {
				api: API,
				code: 'unavailable',
				message: 'Frame history is not supported.',
			});
		if (failure || !latest)
			return json(response, 503, {
				api: API,
				code: 'unavailable',
				message: failure ?? 'Waiting for the first camera frame.',
			});
		json(response, 200, {
			api: API,
			observations: [
				{ at: latest.at, parts: [{ kind: 'frame', file: latest.digest, mediaType: 'image/png' }] },
			],
		});
	}
	function index(response: ServerResponse) {
		json(response, 200, {
			api: API,
			source,
			sensors: [
				{
					name: SENSOR,
					description: 'Mac camera, PNG frames at five frames per second.',
					spans: false,
				},
			],
		});
	}
	function route(request: IncomingMessage, response: ServerResponse) {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		if (request.method !== 'GET')
			return json(response, 404, { api: API, code: 'unknown', message: 'Unknown path.' });
		if (url.pathname === '/') return index(response);
		if (url.pathname === `/${SENSOR}/observe`) return observe(response, url.searchParams);
		if (url.pathname.startsWith('/files/')) return sendFile(response, url.pathname);
		json(response, 404, { api: API, code: 'unknown', message: 'Unknown path.' });
	}
	const server = createServer((request, response) => {
		try {
			route(request, response);
		} catch {
			json(response, 400, { api: API, code: 'invalid', message: 'Invalid request.' });
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('No camera port.');
	return {
		port: address.port,
		source,
		get latest() {
			return latest;
		},
		get failure() {
			return failure;
		},
		receive(frame: Frame) {
			latest = frame;
			failure = undefined;
			frames.set(frame.digest, frame.png);
			if (frames.size > 10) frames.delete(frames.keys().next().value ?? '');
		},
		fail(message: string) {
			failure = message;
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
}

/** Whether the query is empty, or holds exactly one `from` and one `to` that make a span. */
function validQuery(query: URLSearchParams): boolean {
	if (query.size === 0) return true;
	const from = query.getAll('from');
	const to = query.getAll('to');
	if (query.size !== 2 || from.length !== 1 || to.length !== 1) return false;
	const [start, end] = [from[0], to[0]];
	return canonicalTime(start) && canonicalTime(end) && start < end;
}
function canonicalTime(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const time = new Date(value);
	return Number.isFinite(time.valueOf()) && time.toISOString() === value;
}
