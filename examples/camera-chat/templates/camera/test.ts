import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { demoFrame } from './frame.ts';
import { API, openSensor, SENSOR } from './server.ts';

const SOURCE = { repository: 'observer/camera', commit: 'a'.repeat(40), dirty: false };
const SPAN = 'from=2025-01-02T03:04:00.000Z&to=2025-01-02T03:05:00.000Z';

interface Reply {
	status: number;
	contentType: string | null;
	body: unknown;
	bytes: Buffer;
}

/** One request to the server, with the raw body as bytes and as JSON when it parses. */
async function request(root: string, path: string, method = 'GET'): Promise<Reply> {
	const response = await fetch(`${root}${path}`, { method });
	const bytes = Buffer.from(await response.arrayBuffer());
	let body: unknown;
	try {
		body = JSON.parse(bytes.toString());
	} catch {}
	return {
		status: response.status,
		contentType: response.headers.get('content-type'),
		body,
		bytes,
	};
}

const errorOf = (reply: Reply, status: number, code: string, what: string) => {
	assert.equal(reply.status, status, `${what} returns ${status}`);
	assert.match(reply.contentType ?? '', /^application\/json/);
	assert.deepEqual(Object.keys(reply.body as object).sort(), ['api', 'code', 'message']);
	assert.equal((reply.body as { api: number }).api, API);
	assert.equal((reply.body as { code: string }).code, code, `${what} has the code ${code}`);
};

test('serves the index, the latest frame, and immutable PNG bytes at API 2', async () => {
	const sensor = await openSensor(SOURCE);
	try {
		const root = `http://127.0.0.1:${sensor.port}`;
		const index = await request(root, '/');
		assert.equal(index.status, 200);
		assert.deepEqual(index.body, {
			api: 2,
			source: SOURCE,
			sensors: [
				{
					name: SENSOR,
					description: 'Mac camera, PNG frames at five frames per second.',
					spans: false,
				},
			],
		});

		// Before the first frame, the camera is unavailable.
		errorOf(await request(root, `/${SENSOR}/observe`), 503, 'unavailable', 'a read before a frame');

		const frame = demoFrame();
		sensor.receive(frame);
		const latest = await request(root, `/${SENSOR}/observe`);
		assert.equal(latest.status, 200);
		assert.deepEqual(latest.body, {
			api: 2,
			observations: [
				{ at: frame.at, parts: [{ kind: 'frame', file: frame.digest, mediaType: 'image/png' }] },
			],
		});
		assert.match(frame.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

		const file = await request(root, `/files/${frame.digest}`);
		assert.equal(file.status, 200);
		assert.equal(file.contentType, 'image/png');
		assert.equal(createHash('sha256').update(file.bytes).digest('hex'), frame.digest);
		assert.ok(file.bytes.equals(frame.png));

		// A valid span is unsupported. A malformed query is invalid.
		errorOf(await request(root, `/${SENSOR}/observe?${SPAN}`), 422, 'unavailable', 'a span');
		for (const query of [
			'from=2025-01-02T03:05:00.000Z&to=2025-01-02T03:04:00.000Z',
			'from=2025-01-02T03:04:00.000Z&to=2025-01-02T03:04:00.000Z',
			'from=2025-01-02T03:04:00.000Z',
			'to=2025-01-02T03:05:00.000Z',
			'from=2025-01-02T03:04:00Z&to=2025-01-02T03:05:00Z',
			`${SPAN}&limit=1`,
			'from=2025-01-02T03:04:00.000Z&from=2025-01-02T03:04:00.000Z&to=2025-01-02T03:05:00.000Z',
		])
			errorOf(await request(root, `/${SENSOR}/observe?${query}`), 400, 'invalid', query);

		for (const [path, method] of [
			['/unknown/observe', 'GET'],
			[`/files/${'0'.repeat(64)}`, 'GET'],
			['/unknown-path', 'GET'],
			[`/${SENSOR}/observe`, 'POST'],
		] as const)
			errorOf(await request(root, path, method), 404, 'unknown', `${method} ${path}`);

		// A camera failure makes the next read unavailable, and a frame clears it.
		sensor.fail('The camera stopped.');
		const failed = await request(root, `/${SENSOR}/observe`);
		errorOf(failed, 503, 'unavailable', 'a read after a failure');
		assert.equal((failed.body as { message: string }).message, 'The camera stopped.');
		sensor.receive(frame);
		assert.equal((await request(root, `/${SENSOR}/observe`)).status, 200);
	} finally {
		await sensor.close();
	}
});

test('keeps the last ten frames and forgets the older ones', async () => {
	const sensor = await openSensor(SOURCE);
	try {
		const root = `http://127.0.0.1:${sensor.port}`;
		const frames = Array.from({ length: 11 }, (_unused, index) => {
			const frame = demoFrame();
			return { ...frame, digest: index.toString(16).padStart(64, '0') };
		});
		for (const frame of frames) sensor.receive(frame);
		assert.equal((await request(root, `/files/${frames[0]?.digest}`)).status, 404);
		assert.equal((await request(root, `/files/${frames[10]?.digest}`)).status, 200);
	} finally {
		await sensor.close();
	}
});
