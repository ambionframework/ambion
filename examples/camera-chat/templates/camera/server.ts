import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SensorSource } from '@ambionframework/workspace/sensors';
import type { Frame } from './frame.ts';

function json(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
	let body = '';
	for await (const bytes of request) {
		body += bytes.toString();
		if (body.length > 4096) throw new Error('Request too large.');
	}
	return JSON.parse(body);
}

/** Host the version 1 API on a private local port. Keep recent frame bytes immutable. */
export async function openSensor(source: SensorSource) {
	let latest: Frame | undefined;
	let failure: string | undefined;
	const frames = new Map<string, Buffer>();
	function sendFile(response: ServerResponse, path: string) {
		const png = frames.get(path.slice(7));
		if (!png)
			return json(response, 404, {
				api: 1,
				code: 'unknown',
				message: 'The frame is no longer buffered.',
			});
		response.writeHead(200, { 'content-type': 'image/png' });
		response.end(png);
	}
	function observe(response: ServerResponse, body: unknown) {
		if (!validRequest(body))
			return json(response, 400, {
				api: 1,
				code: 'invalid',
				message: 'Invalid observation request.',
			});
		if ('span' in body)
			return json(response, 422, {
				api: 1,
				code: 'unavailable',
				message: 'Frame history is not supported.',
			});
		if (failure || !latest)
			return json(response, 503, {
				api: 1,
				code: 'unavailable',
				message: failure ?? 'Waiting for the first camera frame.',
			});
		json(response, 200, {
			api: 1,
			observations: [
				{ at: latest.at, parts: [{ kind: 'frame', file: latest.digest, mediaType: 'image/png' }] },
			],
		});
	}
	const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => unknown>([
		[
			'GET /',
			(_request, response) =>
				json(response, 200, {
					api: 1,
					source,
					sensors: [
						{
							name: 'camera',
							description: 'Mac camera, PNG frames at five frames per second.',
							spans: false,
						},
					],
				}),
		],
		[
			'POST /camera/observe',
			async (request, response) => observe(response, await readRequest(request)),
		],
	]);
	const server = createServer(async (request, response) => {
		try {
			const route = routes.get(`${request.method} ${request.url}`);
			if (route) return await route(request, response);
			if (request.method === 'GET' && request.url?.startsWith('/files/'))
				return sendFile(response, request.url);
			json(response, 404, { api: 1, code: 'unknown', message: 'Unknown path.' });
		} catch {
			json(response, 400, { api: 1, code: 'invalid', message: 'Invalid request.' });
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('No sensor port.');
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
			if (frames.size > 60) frames.delete(frames.keys().next().value ?? '');
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

function validRequest(body: unknown): body is { api: 1; span?: unknown } {
	if (typeof body !== 'object' || body === null || !('api' in body) || body.api !== 1) return false;
	if (!Object.keys(body).every((key) => key === 'api' || key === 'span')) return false;
	return !('span' in body) || validSpan(body.span);
}
function validSpan(span: unknown): boolean {
	if (typeof span !== 'object' || span === null || !('from' in span) || !('to' in span))
		return false;
	if (Object.keys(span).length !== 2) return false;
	return canonicalTime(span.from) && canonicalTime(span.to) && span.from < span.to;
}
function canonicalTime(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const time = new Date(value);
	return Number.isFinite(time.valueOf()) && time.toISOString() === value;
}
