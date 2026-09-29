import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	isValidObserveRequest,
	ObserveRequestSchema,
	ObserveResponseSchema,
	SensorErrorSchema,
	SensorIndexSchema,
} from '@ambionframework/workspace/sensors';
import { Check } from 'typebox/value';

const checkout = await realpath(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = await realpath(git(['rev-parse', '--show-toplevel'], checkout));
const source = captureSource(repositoryRoot);
const defaultDataPath = join(
	process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
	'ambion',
	'sensor-server',
	createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 16),
);
const dataPath = await prepareDataDirectory(process.env.AMBION_SENSOR_DATA_DIR || defaultDataPath);
const blobPath = join(dataPath, 'blobs');
await mkdir(blobPath, { recursive: true });

const frameBytes = await readFile(new URL('./fixtures/frame.png', import.meta.url));
const frameDigest = digest(frameBytes);
const observations = {
	'room-temperature': {
		at: '2025-01-02T03:04:05.000Z',
		parts: [
			{
				kind: 'series',
				channel: 'temperature',
				unit: 'degC',
				from: '2025-01-02T03:04:05.000Z',
				intervalMs: 1000,
				values: [21.5, 21.6, 21.4],
			},
		],
	},
	'bench-camera': {
		at: '2025-01-02T03:04:06.000Z',
		parts: [{ kind: 'frame', file: frameDigest, mediaType: 'image/png' }],
	},
	'operator-notes': {
		at: '2025-01-02T03:04:07.000Z',
		parts: [{ kind: 'text', text: 'Fixture run: the indicator is green.' }],
	},
};
for (const observation of Object.values(observations)) {
	if (!Check(ObserveResponseSchema, { api: 1, observations: [observation] })) {
		throw new Error('A fixture fails the SN1 observation schema.');
	}
}
const sensors = Object.keys(observations).map((name) => ({
	name,
	description: `Deterministic ${name} fixture.`,
	spans: false,
}));
const index = { api: 1, source, sensors };
if (!Check(SensorIndexSchema, index)) throw new Error('The sensor index fails the SN1 schema.');

await storeBlob(frameDigest, frameBytes);
await writeFile(join(dataPath, 'acquisition.json'), `${JSON.stringify(observations)}\n`, {
	flag: 'wx',
}).catch((error) => {
	if (error.code !== 'EEXIST') throw error;
});

const server = createServer(async (request, response) => {
	try {
		if (request.method === 'GET' && request.url === '/') {
			return sendJson(response, 200, index);
		}
		if (request.method === 'GET' && request.url?.startsWith('/files/')) {
			return await sendFile(response, request.url.slice('/files/'.length));
		}
		const match = request.method === 'POST' && request.url?.match(/^\/([a-z][a-z0-9-]*)\/observe$/);
		if (match) return await observe(response, match[1], request);
		return sendError(response, 404, 'unknown', 'The sensor path does not exist.');
	} catch (error) {
		return sendError(
			response,
			503,
			'unavailable',
			error instanceof Error ? error.message : 'The sensor is unavailable.',
		);
	}
});

const port = parsePort(process.env.PORT);
server.listen(port, '127.0.0.1', () => {
	const address = server.address();
	if (!address || typeof address === 'string')
		throw new Error('The server did not bind a TCP port.');
	process.stdout.write(`READY http://127.0.0.1:${address.port}\n`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => server.close(() => process.exit(0)));
}

async function observe(response, name, request) {
	if (!Object.hasOwn(observations, name)) {
		return sendError(response, 404, 'unknown', `Sensor ${name} does not exist.`);
	}
	const sensor = observations[name];
	let body;
	try {
		body = await readJson(request);
	} catch (error) {
		return sendError(response, 400, 'invalid', error.message);
	}
	if (!Check(ObserveRequestSchema, body) || !isValidObserveRequest(body)) {
		return sendError(response, 400, 'invalid', 'The request does not match the SN1 schema.');
	}
	if (body.span)
		return sendError(response, 422, 'unavailable', 'This fixture does not support span reads.');
	const found = [sensor];
	const result = { api: 1, observations: found };
	if (!Check(ObserveResponseSchema, result))
		throw new Error('The observation fails the SN1 schema.');
	await appendFile(
		join(dataPath, 'observations.jsonl'),
		`${JSON.stringify({ sensor: name, request: body, result })}\n`,
	);
	return sendJson(response, 200, result);
}

async function sendFile(response, file) {
	if (!/^[0-9a-f]{64}$/.test(file))
		return sendError(response, 404, 'unknown', 'The file digest does not exist.');
	try {
		const bytes = await readFile(join(blobPath, file));
		if (digest(bytes) !== file)
			return sendError(response, 503, 'unavailable', 'The stored file digest does not match.');
		response.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length });
		return response.end(bytes);
	} catch {
		return sendError(response, 404, 'unknown', 'The file digest does not exist.');
	}
}

async function storeBlob(hash, bytes) {
	const target = join(blobPath, hash);
	try {
		const existing = await readFile(target);
		if (digest(existing) !== hash) throw new Error('The stored file digest does not match.');
	} catch {
		await writeFile(target, bytes, { flag: 'wx' }).catch(async (error) => {
			if (error.code !== 'EEXIST') throw error;
			const existing = await readFile(target);
			if (digest(existing) !== hash) throw new Error('The stored file digest does not match.');
		});
	}
}

async function prepareDataDirectory(path) {
	if (!isAbsolute(path)) throw new Error('AMBION_SENSOR_DATA_DIR must be an absolute path.');
	const requested = resolve(path);
	assertOutsideCheckout(await realPathWithMissingTail(requested));
	await mkdir(requested, { recursive: true });
	const real = await realpath(requested);
	assertOutsideCheckout(real);
	return real;
}

async function realPathWithMissingTail(path) {
	let ancestor = path;
	const tail = [];
	while (true) {
		try {
			await stat(ancestor);
			return resolve(await realpath(ancestor), ...tail);
		} catch {
			const parent = dirname(ancestor);
			if (parent === ancestor) throw new Error('No existing parent directory for sensor data.');
			tail.unshift(basename(ancestor));
			ancestor = parent;
		}
	}
}

function assertOutsideCheckout(path) {
	const fromCheckout = relative(repositoryRoot, path);
	if (
		fromCheckout === '' ||
		(!fromCheckout.startsWith(`..${sep}`) && fromCheckout !== '..' && !isAbsolute(fromCheckout))
	) {
		throw new Error('Sensor data must live outside the Git checkout.');
	}
}

function captureSource(root) {
	const commit = git(['rev-parse', 'HEAD'], root);
	const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], root, true);
	const dirty = git(['status', '--porcelain', '--untracked-files=all'], root).length > 0;
	const origin = git(['config', '--get', 'remote.origin.url'], root, true);
	const repository = process.env.AMBION_SENSOR_REPOSITORY || repositoryName(origin);
	return { repository, commit, ...(branch ? { branch } : {}), dirty };
}

function repositoryName(remote) {
	const match = remote.match(/(?:[:/])([^/:]+)\/([^/]+?)(?:\.git)?$/);
	if (!match)
		throw new Error('Set AMBION_SENSOR_REPOSITORY to namespace/name or configure origin.');
	return `${match[1]}/${match[2]}`;
}

function git(args, cwd, allowMissing = false) {
	try {
		return execFileSync('git', args, {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
		}).trim();
	} catch (error) {
		if (allowMissing) return '';
		throw new Error(`Git could not read launch metadata (${args.join(' ')}).`, { cause: error });
	}
}

function parsePort(value) {
	if (value === undefined || value === '') return 0;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error('PORT must be an integer from 0 to 65535.');
	return port;
}

function digest(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function readJson(request) {
	return new Promise((resolveBody, reject) => {
		let raw = '';
		request.setEncoding('utf8');
		request.on('data', (part) => {
			raw += part;
			if (raw.length > 64 * 1024) reject(new Error('The request body exceeds 64 KiB.'));
		});
		request.on('end', () => {
			try {
				resolveBody(JSON.parse(raw));
			} catch {
				reject(new Error('The request body is not valid JSON.'));
			}
		});
		request.on('error', reject);
	});
}

function sendJson(response, status, value) {
	response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	response.end(JSON.stringify(value));
}

function sendError(response, status, code, message) {
	const error = { api: 1, code, message };
	if (!Check(SensorErrorSchema, error)) throw new Error('The error fails the SN1 schema.');
	return sendJson(response, status, error);
}
