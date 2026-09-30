import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import {
	createSensorClient,
	SensorDigestError,
	type SensorIndex,
	SensorProtocolError,
} from '../src/sensors.ts';

const index: SensorIndex = {
	api: 1,
	source: {
		repository: 'instruments/bench-sensors',
		commit: 'a'.repeat(40),
		branch: 'main',
		dirty: false,
	},
	sensors: [{ name: 'dmm', description: 'Meter', spans: true }],
};
const observationTime = '2026-09-29T08:07:06.005Z';
const observation = {
	api: 1,
	observations: [
		{
			at: observationTime,
			parts: [
				{
					kind: 'series',
					channel: 'voltage',
					unit: 'V',
					from: '2026-09-29T08:07:06.005Z',
					intervalMs: 0.125,
					values: [4.2],
				},
			],
		},
	],
};
const bytes = new Uint8Array([0, 1, 2, 255]);
const digest = createHash('sha256').update(bytes).digest('hex');

it('reads all operations over real HTTP, keeps a prefixed root, and preserves measurement times', async () => {
	const paths: string[] = [];
	let posted: { method?: string; body?: unknown } = {};
	const server = await listening((request, response) => {
		paths.push(request.url ?? '');
		if (request.url === '/transport/') return json(response, index);
		if (request.url === '/transport/dmm/observe') {
			let body = '';
			request.setEncoding('utf8');
			request.on('data', (chunk: string) => (body += chunk));
			request.on('end', () => {
				posted = { method: request.method, body: JSON.parse(body) };
				json(response, observation);
			});
			return;
		}
		if (request.url === `/transport/files/${digest}`) {
			response.writeHead(200, { 'content-type': 'application/octet-stream' });
			response.end(bytes);
			return;
		}
		json(response, { api: 1, code: 'unknown', message: 'missing' }, 404);
	});
	try {
		const client = createSensorClient(`${root(server)}/transport`);
		expect(await client.index()).toEqual(index);
		const span = { from: '2026-09-29T08:07:06.000Z', to: '2026-09-29T08:07:07.000Z' };
		const result = await client.observe('dmm', { api: 1, span });
		expect(result.observations[0]?.at).toBe(observationTime);
		expect(result.observations[0]?.parts[0]).toMatchObject({
			kind: 'series',
			from: '2026-09-29T08:07:06.005Z',
			intervalMs: 0.125,
		});
		expect(posted).toEqual({ method: 'POST', body: { api: 1, span } });
		const file = await client.file(digest);
		expect([...file.bytes]).toEqual([...bytes]);
		expect(file.mediaType).toBe('application/octet-stream');
		expect(paths).toEqual(['/transport/', '/transport/dmm/observe', `/transport/files/${digest}`]);
	} finally {
		await close(server);
	}
});

it('rejects unsupported wire versions even when the response shapes are otherwise valid', async () => {
	let requests = 0;
	const server = await listening((request, response) => {
		requests++;
		if (request.url === '/') return json(response, { ...index, api: 2 });
		json(response, { ...observation, api: 2 });
	});
	try {
		const client = createSensorClient(root(server));
		await expect(client.index()).rejects.toBeInstanceOf(SensorProtocolError);
		await expect(client.observe('dmm')).rejects.toBeInstanceOf(SensorProtocolError);
		expect(requests).toBe(2);
	} finally {
		await close(server);
	}
});

it('rejects malformed index and observation bodies with api version 1', async () => {
	const server = await listening((request, response) => {
		if (request.url === '/')
			return json(response, {
				...index,
				sensors: [{ ...index.sensors[0], name: 'dmm\n' }],
			});
		json(response, { api: 1, observations: [{ at: 'not-a-time', parts: [] }] });
	});
	try {
		const client = createSensorClient(root(server));
		await expect(client.index()).rejects.toBeInstanceOf(SensorProtocolError);
		await expect(client.observe('dmm')).rejects.toBeInstanceOf(SensorProtocolError);
	} finally {
		await close(server);
	}
});

it('turns malformed JSON success and error bodies into protocol failures', async () => {
	const successful = await listening((_request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end('{');
	});
	try {
		await expect(createSensorClient(root(successful)).index()).rejects.toBeInstanceOf(
			SensorProtocolError,
		);
	} finally {
		await close(successful);
	}
	const failed = await listening((_request, response) => {
		response.writeHead(503, { 'content-type': 'application/json' });
		response.end('{');
	});
	try {
		await expect(createSensorClient(root(failed)).index()).rejects.toMatchObject({
			name: 'SensorProtocolError',
			status: 503,
		});
	} finally {
		await close(failed);
	}
});

it('reports valid HTTP error envelopes and malformed error envelopes explicitly', async () => {
	const server = await listening((_request, response) =>
		json(response, { api: 1, code: 'unknown', message: 'file does not exist' }, 404),
	);
	try {
		await expect(createSensorClient(root(server)).file('a'.repeat(64))).rejects.toMatchObject({
			name: 'SensorHttpError',
			status: 404,
			sensorError: { code: 'unknown' },
		});
	} finally {
		await close(server);
	}
	const malformed = await listening((_request, response) => json(response, { api: 2 }, 404));
	try {
		await expect(createSensorClient(root(malformed)).index()).rejects.toMatchObject({
			name: 'SensorProtocolError',
			status: 404,
		});
	} finally {
		await close(malformed);
	}
});

it('rejects a file whose bytes do not match its requested digest', async () => {
	const server = await listening((_request, response) => {
		response.writeHead(200, { 'content-type': 'image/png' });
		response.end('different bytes');
	});
	try {
		await expect(createSensorClient(root(server)).file(digest)).rejects.toBeInstanceOf(
			SensorDigestError,
		);
	} finally {
		await close(server);
	}
});

it('rejects a file response without a media type', async () => {
	const server = await listening((_request, response) => response.end('bytes'));
	try {
		await expect(createSensorClient(root(server)).file(digest)).rejects.toMatchObject({
			name: 'SensorProtocolError',
			status: 200,
		});
	} finally {
		await close(server);
	}
});

it('rejects unsafe names and digests before issuing a request', async () => {
	let count = 0;
	const server = await listening((_request, response) => {
		count++;
		json(response, index);
	});
	try {
		const client = createSensorClient(root(server));
		await expect(client.observe('dmm\n')).rejects.toBeInstanceOf(SensorProtocolError);
		await expect(client.observe(undefined as unknown as string)).rejects.toBeInstanceOf(
			SensorProtocolError,
		);
		await expect(client.file(`${digest}\n`)).rejects.toBeInstanceOf(SensorProtocolError);
		expect(count).toBe(0);
	} finally {
		await close(server);
	}
});

it('propagates pre-request and in-body abort reasons', async () => {
	const controller = new AbortController();
	const reason = new Error('caller stopped the read');
	controller.abort(reason);
	const unused = await listening((_request, response) => json(response, index));
	try {
		const client = createSensorClient(root(unused));
		await expect(client.index(controller.signal)).rejects.toBe(reason);
		await expect(client.observe('dmm', undefined, controller.signal)).rejects.toBe(reason);
		await expect(client.file(digest, controller.signal)).rejects.toBe(reason);
	} finally {
		await close(unused);
	}

	let announceStarted!: () => void;
	const started = new Promise<void>((resolve) => (announceStarted = resolve));
	const server = await listening((_request, response) => {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.write('{"api":');
		announceStarted();
	});
	try {
		const inBody = new AbortController();
		const request = createSensorClient(root(server)).observe('dmm', undefined, inBody.signal);
		await started;
		const bodyReason = new SyntaxError('caller abort reason that resembles a JSON parse error');
		inBody.abort(bodyReason);
		await expect(request).rejects.toBe(bodyReason);
	} finally {
		await close(server);
	}
});

it('propagates a disconnect while reading a file body', async () => {
	const server = await listening((_request, response) => {
		response.writeHead(200, {
			'content-type': 'application/octet-stream',
			'content-length': '100',
		});
		response.flushHeaders();
		response.write('partial');
		setImmediate(() => response.destroy());
	});
	try {
		await expect(createSensorClient(root(server)).file(digest)).rejects.toBeInstanceOf(Error);
	} finally {
		await close(server);
	}
});

it('surfaces a server disconnect and never follows a redirecting observe POST', async () => {
	let disconnectedPosts = 0;
	const disconnected = await listening((request, response) => {
		if (request.method === 'POST') disconnectedPosts++;
		response.destroy();
	});
	try {
		await expect(createSensorClient(root(disconnected)).observe('dmm')).rejects.toBeInstanceOf(
			Error,
		);
		expect(disconnectedPosts).toBe(1);
	} finally {
		await close(disconnected);
	}

	let postCount = 0;
	const redirect = await listening((request, response) => {
		if (request.method === 'POST') postCount++;
		response.writeHead(307, { location: '/replayed' });
		response.end();
	});
	try {
		await expect(createSensorClient(root(redirect)).observe('dmm')).rejects.toBeInstanceOf(Error);
		expect(postCount).toBe(1);
	} finally {
		await close(redirect);
	}
});

async function listening(handler: RequestListener): Promise<Server> {
	const server = createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return server;
}

function root(server: Server): string {
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Server is not listening.');
	return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
	server.closeAllConnections();
	server.close();
	await once(server, 'close');
}

function json(response: ServerResponse, value: unknown, status = 200) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(value));
}
