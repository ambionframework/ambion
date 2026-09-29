import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
	ObserveResponseSchema,
	SensorErrorSchema,
	SensorIndexSchema,
} from '@ambionframework/workspace/sensors';
import { Check } from 'typebox/value';

const template = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = await findPackageRoot(
	fileURLToPath(import.meta.resolve('@ambionframework/workspace/sensors')),
	'@ambionframework/workspace',
);
const typeboxRoot = await findPackageRoot(
	fileURLToPath(import.meta.resolve('typebox/value')),
	'typebox',
);

test('server fixtures, launch metadata, and data safety follow SN1', async (context) => {
	const root = await mkdtemp(join(tmpdir(), 'ambion-sensor-template-'));
	context.after(() => rm(root, { recursive: true, force: true }));
	const bare = join(root, 'fork.git');
	const checkout = join(root, 'fork');
	const data = join(root, 'data');
	git(root, ['init', '--bare', bare]);
	git(root, ['clone', bare, checkout]);
	await cp(template, checkout, {
		recursive: true,
		filter: (path) => !path.split(sep).some((part) => part === '.git' || part === 'node_modules'),
	});
	await linkDependencies(checkout);
	git(checkout, ['config', 'user.name', 'Sensor Test']);
	git(checkout, ['config', 'user.email', 'sensor@example.invalid']);
	git(checkout, ['switch', '-c', 'main']);
	git(checkout, ['add', '.']);
	git(checkout, ['commit', '-m', 'Add sensor template']);
	git(checkout, ['push', '-u', 'origin', 'main']);
	const baseCommit = git(checkout, ['rev-parse', 'HEAD']);

	const clean = await start(checkout, data);
	context.after(() => clean.stop());
	const index = await clean.get('/');
	assert.equal(Check(SensorIndexSchema, index), true);
	assert.deepEqual(index.source, {
		repository: 'agent/sensors',
		commit: baseCommit,
		branch: 'main',
		dirty: false,
	});
	const allFixtures = new Map();
	for (const sensor of index.sensors) {
		const result = await clean.observe(sensor.name);
		assert.equal(Check(ObserveResponseSchema, result), true);
		allFixtures.set(sensor.name, result);
	}
	const numeric = [...allFixtures.values()].find((result) =>
		result.observations[0].parts.some((part) => part.kind === 'series'),
	);
	const frame = [...allFixtures.values()].find((result) =>
		result.observations[0].parts.some((part) => part.kind === 'frame'),
	);
	const text = [...allFixtures.values()].find((result) =>
		result.observations[0].parts.some((part) => part.kind === 'text'),
	);
	assert.ok(numeric && frame && text, 'all numeric, frame, and text fixtures are present');
	assert.equal(Check(ObserveResponseSchema, numeric), true);
	const series = numeric.observations[0].parts[0];
	assert.equal(series.kind, 'series');
	assert.ok(series.values.length > 0 && series.values.every(Number.isFinite));
	const digest = frame.observations[0].parts[0].file;
	const bytes = await clean.bytes(`/files/${digest}`);
	assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
	const chunks = assertPng(bytes);
	const idat = chunks.find((chunk) => chunk.type === 'IDAT');
	assert.ok(idat);
	const damaged = Buffer.from(bytes);
	damaged.writeUInt32BE((idat.crc ^ 1) >>> 0, idat.crcOffset);
	assert.throws(() => assertPng(damaged), /PNG IDAT chunk has a valid CRC/);
	const fixturePath = join(checkout, 'fixtures/frame.png');
	const fixtureBytes = await readFile(fixturePath);
	await writeFile(fixturePath, 'edited fixture after launch');
	assert.deepEqual(await clean.bytes(`/files/${digest}`), bytes);
	await writeFile(fixturePath, fixtureBytes);
	assert.equal(typeof text.observations[0].parts[0].text, 'string');
	assert.ok(text.observations[0].parts[0].text.length > 0);
	const seriesName = [...allFixtures].find(([, result]) => result === numeric)[0];
	assert.equal((await readFile(join(data, 'acquisition.json'), 'utf8')).includes(seriesName), true);
	const badRequest = await clean.post(`/${seriesName}/observe`, '{');
	assert.equal(badRequest.status, 400);
	assert.equal(Check(SensorErrorSchema, badRequest.body), true);
	for (const body of [
		{ api: 2 },
		{ api: 1, span: { from: '2025-01-02T03:04:06.000Z', to: '2025-01-02T03:04:05.000Z' } },
		{ api: 1, span: { from: '2025-01-02T03:04:05.000Z', to: '2025-01-02T03:04:05.000Z' } },
	]) {
		const invalid = await clean.post(`/${seriesName}/observe`, JSON.stringify(body));
		assert.equal(invalid.status, 400);
		assert.equal(Check(SensorErrorSchema, invalid.body), true);
	}
	const span = await clean.post(
		`/${seriesName}/observe`,
		JSON.stringify({
			api: 1,
			span: { from: '2025-01-02T03:04:05.000Z', to: '2025-01-02T03:04:06.000Z' },
		}),
	);
	assert.equal(span.status, 422);
	for (const path of ['/constructor/observe', '/unknown/observe', '/missing/path']) {
		assert.equal((await clean.post(path, '{"api":1}')).status, 404);
	}
	assert.equal(await clean.status(`/files/${'a'.repeat(64)}`), 404);

	await writeFile(join(checkout, 'README.md'), 'edited after launch\n');
	git(checkout, ['add', 'README.md']);
	git(checkout, ['commit', '-m', 'Edit after clean launch']);
	assert.deepEqual((await clean.get('/')).source, index.source);
	await clean.stop();
	const requestedPort = await unusedPort();
	const assigned = await start(checkout, join(root, 'assigned-data'), { port: requestedPort });
	context.after(() => assigned.stop());
	assert.equal(assigned.port, requestedPort);
	await assigned.stop();

	const dirtyFile = join(checkout, 'dirty.txt');
	await writeFile(dirtyFile, 'dirty at launch\n');
	const dirty = await start(checkout, join(root, 'dirty-data'));
	context.after(() => dirty.stop());
	const dirtyIndex = await dirty.get('/');
	assert.equal(dirtyIndex.source.dirty, true);
	const dirtyCommit = git(checkout, ['rev-parse', 'HEAD']);
	git(checkout, ['add', 'dirty.txt']);
	git(checkout, ['commit', '-m', 'Save dirty launch']);
	assert.equal((await dirty.get('/')).source.commit, dirtyCommit);
	assert.equal((await dirty.get('/')).source.dirty, true);
	await dirty.stop();
	git(checkout, ['switch', '--detach', 'HEAD']);
	const detached = await start(checkout, join(root, 'detached-data'));
	context.after(() => detached.stop());
	assert.equal('branch' in (await detached.get('/')).source, false);
	await detached.stop();
	git(checkout, ['switch', 'main']);

	const linkedData = join(root, 'linked-data');
	await mkdir(join(checkout, 'inside-data'));
	await symlink(join(checkout, 'inside-data'), linkedData, 'dir');
	const refused = await start(checkout, linkedData, { expectExit: true });
	assert.match(refused.output, /outside the Git checkout/);
	assert.deepEqual(await readdir(join(checkout, 'inside-data')), []);
});

function git(cwd, args) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function assertPng(bytes) {
	assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
	const chunks = [];
	const imageData = [];
	let offset = 8;
	while (offset < bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const typeStart = offset + 4;
		const dataStart = typeStart + 4;
		const dataEnd = dataStart + length;
		const crcEnd = dataEnd + 4;
		assert.ok(crcEnd <= bytes.length, 'PNG chunk length stays within the file');
		const type = bytes.toString('ascii', typeStart, dataStart);
		const expectedCrc = bytes.readUInt32BE(dataEnd);
		const actualCrc = crc32(
			Buffer.concat([bytes.subarray(typeStart, dataStart), bytes.subarray(dataStart, dataEnd)]),
		);
		assert.equal(actualCrc, expectedCrc, `PNG ${type} chunk has a valid CRC`);
		chunks.push({ type, crc: expectedCrc, crcOffset: dataEnd, length });
		if (type === 'IDAT') imageData.push(bytes.subarray(dataStart, dataEnd));
		offset = crcEnd;
	}
	assert.equal(offset, bytes.length, 'PNG has no bytes after IEND');
	assert.equal(chunks[0]?.type, 'IHDR');
	assert.equal(chunks[0]?.length, 13);
	assert.equal(chunks.at(-1)?.type, 'IEND');
	assert.equal(chunks.at(-1)?.length, 0);
	assert.equal(chunks.filter((chunk) => chunk.type === 'IHDR').length, 1);
	assert.ok(chunks.some((chunk) => chunk.type === 'IDAT'));
	const header = bytes.subarray(16, 29);
	assert.ok(header.readUInt32BE(0) > 0);
	assert.ok(header.readUInt32BE(4) > 0);
	const decoded = inflateSync(Buffer.concat(imageData));
	assert.ok(decoded.length > 0, 'PNG image data inflates');
	return chunks;
}

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

async function findPackageRoot(file, name) {
	let directory = dirname(file);
	while (directory !== dirname(directory)) {
		try {
			const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
			if (manifest.name === name) return directory;
		} catch {}
		directory = dirname(directory);
	}
	throw new Error(`Cannot find the installed package ${name}.`);
}

async function linkDependencies(project) {
	const modules = join(project, 'node_modules');
	const scope = join(modules, '@ambionframework');
	await mkdir(scope, { recursive: true });
	await symlink(workspaceRoot, join(scope, 'workspace'), 'dir');
	await symlink(typeboxRoot, join(modules, 'typebox'), 'dir');
}

async function start(cwd, dataPath, { expectExit = false, port = 0 } = {}) {
	const child = spawn(process.execPath, ['server.mjs'], {
		cwd,
		env: {
			...process.env,
			AMBION_SENSOR_DATA_DIR: dataPath,
			AMBION_SENSOR_REPOSITORY: 'agent/sensors',
			PORT: String(port),
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (part) => (output += part));
	child.stderr.on('data', (part) => (output += part));
	const ready = new Promise((resolveReady, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`Server did not become ready: ${output}`)),
			5000,
		);
		child.stdout.on('data', (part) => {
			const match = part.match(/READY http:\/\/127\.0\.0\.1:(\d+)/);
			if (match) {
				clearTimeout(timeout);
				resolveReady(Number(match[1]));
			}
		});
		child.once('exit', (code) => {
			clearTimeout(timeout);
			if (expectExit) resolveReady(0);
			else reject(new Error(`Server exited with ${code}: ${output}`));
		});
	});
	const boundPort = await ready;
	if (expectExit) return { output };
	return {
		async get(path) {
			const response = await fetch(`http://127.0.0.1:${boundPort}${path}`);
			return response.json();
		},
		async observe(name) {
			const response = await this.post(`/${name}/observe`, '{"api":1}');
			assert.equal(response.status, 200);
			return response.body;
		},
		async post(path, body) {
			const response = await fetch(`http://127.0.0.1:${boundPort}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			});
			return { status: response.status, body: await response.json() };
		},
		async bytes(path) {
			const response = await fetch(`http://127.0.0.1:${boundPort}${path}`);
			assert.equal(response.status, 200);
			return Buffer.from(await response.arrayBuffer());
		},
		async status(path) {
			const response = await fetch(`http://127.0.0.1:${boundPort}${path}`);
			return response.status;
		},
		port: boundPort,
		async stop() {
			if (child.exitCode !== null) return;
			child.kill('SIGTERM');
			await new Promise((resolveExit) => child.once('exit', resolveExit));
		},
	};
}

async function unusedPort() {
	const listener = createTcpServer();
	await new Promise((resolveListen) => listener.listen(0, '127.0.0.1', resolveListen));
	const address = listener.address();
	if (!address || typeof address === 'string') throw new Error('Could not allocate a test port.');
	await new Promise((resolveClose, rejectClose) =>
		listener.close((error) => (error ? rejectClose(error) : resolveClose())),
	);
	return address.port;
}
