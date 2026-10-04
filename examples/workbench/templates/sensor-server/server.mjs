import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Check } from 'typebox/value';
import { API, ErrorSchema, IndexSchema, ObserveSchema, spanOf } from './api.mjs';

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
	if (!Check(ObserveSchema, { api: API, observations: [observation] })) {
		throw new Error(`A fixture fails the sensor API ${API} observation schema.`);
	}
}
const sensors = Object.keys(observations).map((name) => ({
	name,
	description: `Deterministic ${name} fixture.`,
	spans: false,
}));
const index = { api: API, source, sensors };
if (!Check(IndexSchema, index))
	throw new Error(`The sensor index fails the sensor API ${API} schema.`);

await storeBlob(frameDigest, frameBytes);
await writeFile(join(dataPath, 'acquisition.json'), `${JSON.stringify(observations)}\n`, {
	flag: 'wx',
}).catch((error) => {
	if (error.code !== 'EEXIST') throw error;
});

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		if (request.method === 'GET' && url.pathname === '/') {
			return sendJson(response, 200, index);
		}
		if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
			return await sendFile(response, url.pathname.slice('/files/'.length));
		}
		const match = request.method === 'GET' && url.pathname.match(/^\/([a-z][a-z0-9-]*)\/observe$/);
		if (match) return await observe(response, match[1], url.searchParams);
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

// The workspace sets PORT for every process. The server serves on it and
// prints nothing: a reader reaches the server with fetch.
server.listen(parsePort(process.env.PORT), '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => server.close(() => process.exit(0)));
}

async function observe(response, name, params) {
	if (!Object.hasOwn(observations, name)) {
		return sendError(response, 404, 'unknown', `Sensor ${name} does not exist.`);
	}
	const { span, error } = spanOf(params);
	if (error) return sendError(response, 400, 'invalid', error);
	if (span)
		return sendError(response, 422, 'unavailable', 'This fixture does not support span reads.');
	const result = { api: API, observations: [observations[name]] };
	if (!Check(ObserveSchema, result))
		throw new Error(`The observation fails the sensor API ${API} schema.`);
	await appendFile(
		join(dataPath, 'observations.jsonl'),
		`${JSON.stringify({ sensor: name, request: {}, result })}\n`,
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
	const port = Number(value);
	if (value === undefined || !Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error('PORT must be an integer from 1 to 65535. The workspace sets it.');
	return port;
}

function digest(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

function sendJson(response, status, value) {
	response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
	response.end(JSON.stringify(value));
}

function sendError(response, status, code, message) {
	const error = { api: API, code, message };
	if (!Check(ErrorSchema, error)) throw new Error(`The error fails the sensor API ${API} schema.`);
	return sendJson(response, status, error);
}
