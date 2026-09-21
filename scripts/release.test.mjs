import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { dependencyOrder, isVersion, ROOT } from './packages.mjs';
import { parseOptions } from './publish.mjs';
import { promote, stage, status, verify } from './release.mjs';
import { channelRegistry, tarballName } from './release-lib.mjs';

const TOKEN = 'secret-token-value-1234';
const VERSION = '0.1.0';

function pkg(name, dependencies = {}) {
	return { dir: `/x/${name}`, manifest: { name, version: VERSION, dependencies } };
}
// The cli needs the ambion package, so it comes second whatever the input order.
const PACKAGES = dependencyOrder([
	pkg('@ambionframework/cli', { '@ambionframework/ambion': 'workspace:*' }),
	pkg('@ambionframework/ambion'),
	pkg('@ambionframework/workspace'),
]);

/** Answer one request against the in-memory store. Returns [status, body]. */
function handle(store, method, url, body) {
	const tagMatch = url.match(/^\/-\/package\/(.+)\/dist-tags\/(.+)$/);
	if (method === 'PUT' && tagMatch) {
		store.get(tagMatch[1]).tags[tagMatch[2]] = JSON.parse(body);
		return [200, {}];
	}
	const name = url.slice(1);
	if (method === 'PUT') return publishVersion(store, name, JSON.parse(body));
	const found = store.get(name);
	if (!found) return [404, {}];
	return [200, { versions: [...found.versions], tags: found.tags }];
}

function publishVersion(store, name, { version, tag }) {
	const entry = store.get(name) ?? { versions: new Set(), tags: {} };
	if (entry.versions.has(version)) return [403, { error: 'exists' }];
	entry.versions.add(version);
	entry.tags[tag] = version;
	store.set(name, entry);
	return [200, {}];
}

/** A registry in memory behind node:http: packages, versions, and dist-tags. */
function startRegistry() {
	const store = new Map();
	const requests = [];
	const server = createServer((req, res) => {
		requests.push(`${req.method} ${req.url}`);
		let body = '';
		req.on('data', (chunk) => {
			body += chunk;
		});
		req.on('end', () => {
			const [code, value] = handle(store, req.method, decodeURIComponent(req.url ?? ''), body);
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(JSON.stringify(value));
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolve({ url: `http://127.0.0.1:${port}`, store, requests, server });
		});
	});
}

/** A `run` that answers git and pnpm from a table and npm from the fake registry. */
function fakeRunner(registry, state) {
	const calls = [];
	const run = async (command, args, options = {}) => {
		const call = { command, args: [...args], options };
		calls.push(call);
		if (command === 'git') return gitAnswer(args, state);
		if (command === 'pnpm') return pnpmAnswer(args, state);
		if (command === 'npm') return npmAnswer(registry, args, state, call);
		return { status: 0, stdout: '' };
	};
	return { run, calls };
}

function gitAnswer(args, state) {
	if (args[0] === 'status') return { status: 0, stdout: state.dirty ? ' M file\n' : '' };
	if (args[0] === 'rev-parse') return { status: 0, stdout: 'aaa111\n' };
	if (args[0] === 'rev-list') return { status: 0, stdout: `${state.tagCommit}\n` };
	return { status: 1, stdout: '' };
}

async function pnpmAnswer(args, state) {
	if (args[0] === 'run' && args[1] === 'check') {
		state.gateRuns += 1;
		return { status: state.gatePasses ? 0 : 1, stdout: '' };
	}
	if (args[0] === 'pack') {
		state.packs += 1;
		const name = state.packs;
		return { status: 0, stdout: String(name) };
	}
	return { status: 0, stdout: '' };
}

async function npmAnswer(registry, args, state, call) {
	const config = args.indexOf('--userconfig');
	if (config !== -1) {
		call.configText = await readFile(args[config + 1], 'utf8');
		call.configPath = args[config + 1];
	}
	if (args[0] === 'view') return npmView(registry, args, state);
	if (args[0] === 'publish') return npmPublish(registry, args, state, call);
	if (args[0] === 'dist-tag') return npmDistTag(registry, args);
	return { status: 0, stdout: '' };
}

async function npmView(registry, args, state) {
	// GitHub Packages answers 401 to a read with no token.
	if (state.viewNeedsToken && !args.includes('--userconfig')) return { status: 1, stdout: '' };
	const spec = args[1];
	const at = spec.lastIndexOf('@');
	const hasVersion = at > 0;
	const name = hasVersion ? spec.slice(0, at) : spec;
	const response = await fetch(`${registry}/${encodeURIComponent(name)}`);
	if (response.status !== 200) return { status: 1, stdout: '' };
	const doc = await response.json();
	if (args[2] === 'dist-tags') return { status: 0, stdout: JSON.stringify(doc.tags) };
	const version = spec.slice(at + 1);
	return doc.versions.includes(version)
		? { status: 0, stdout: `${version}\n` }
		: { status: 1, stdout: '' };
}

async function npmPublish(registry, args, state, call) {
	const tarball = args[1];
	const entry = PACKAGES.find((item) =>
		tarball.endsWith(tarballName(item.manifest.name, item.manifest.version)),
	);
	if (!entry) return { status: 1, stdout: '' };
	const tag = args[args.indexOf('--tag') + 1];
	const config = args.indexOf('--userconfig');
	if (config !== -1) {
		call.configText = await readFile(args[config + 1], 'utf8');
		call.configPath = args[config + 1];
	}
	if (args.includes('--dry-run')) return { status: 0, stdout: '' };
	if (state.failPublishOf === entry.manifest.name) return { status: 1, stdout: '' };
	const response = await fetch(`${registry}/${encodeURIComponent(entry.manifest.name)}`, {
		method: 'PUT',
		body: JSON.stringify({ version: entry.manifest.version, tag }),
	});
	return { status: response.status === 200 ? 0 : 1, stdout: '' };
}

async function npmDistTag(registry, args) {
	const at = args[2].lastIndexOf('@');
	const name = args[2].slice(0, at);
	const version = args[2].slice(at + 1);
	const response = await fetch(
		`${registry}/-/package/${encodeURIComponent(name)}/dist-tags/${args[3]}`,
		{ method: 'PUT', body: JSON.stringify(version) },
	);
	return { status: response.status === 200 ? 0 : 1, stdout: '' };
}

describe('release.mjs against a fake registry', () => {
	let fake;
	let outDir;
	let state;
	let logs;
	let runner;

	before(async () => {
		fake = await startRegistry();
		outDir = await mkdtemp(join(tmpdir(), 'ambion-release-test-'));
	});
	after(async () => {
		fake.server.close();
		await rm(outDir, { recursive: true, force: true });
	});
	beforeEach(() => {
		fake.store.clear();
		fake.requests.length = 0;
		state = { dirty: false, tagCommit: 'aaa111', gatePasses: true, gateRuns: 0, packs: 0 };
		logs = [];
		runner = fakeRunner(fake.url, state);
	});

	const context = (overrides = {}) => ({
		packages: PACKAGES,
		run: runner.run,
		env: { NODE_AUTH_TOKEN: TOKEN, PATH: process.env.PATH },
		log: (line) => logs.push(line),
		confirm: async () => true,
		root: '/repo',
		outDir,
		registry: fake.url,
		...overrides,
	});
	const publishCalls = () =>
		runner.calls.filter((c) => c.command === 'npm' && c.args[0] === 'publish');

	it('orders the packages by dependency', () => {
		const names = PACKAGES.map((entry) => entry.manifest.name);
		assert.ok(names.indexOf('@ambionframework/ambion') < names.indexOf('@ambionframework/cli'));
	});

	it('stage publishes each package under next in dependency order', async () => {
		await stage(context(), {});
		const published = publishCalls().map((c) => c.args[1]);
		assert.deepEqual(
			published.map((path) => path.split('/').pop()),
			PACKAGES.map((e) => tarballName(e.manifest.name, VERSION)),
		);
		for (const entry of PACKAGES) {
			assert.equal(fake.store.get(entry.manifest.name).tags.next, VERSION);
			assert.equal(fake.store.get(entry.manifest.name).tags.latest, undefined);
		}
		assert.equal(state.gateRuns, 1);
		assert.equal(state.packs, PACKAGES.length, 'one pack per package, none per publish');
	});

	it('stage skips a version already published and finishes the rest after a failure', async () => {
		state.failPublishOf = '@ambionframework/cli';
		await assert.rejects(stage(context(), {}), /Failed to publish @ambionframework\/cli/);
		assert.ok(fake.store.has('@ambionframework/ambion'));
		assert.ok(!fake.store.has('@ambionframework/cli'));
		state.failPublishOf = undefined;
		logs.length = 0;
		await stage(context(), {});
		assert.ok(logs.some((line) => line.startsWith('skip    @ambionframework/ambion@')));
		for (const entry of PACKAGES)
			assert.ok(fake.store.get(entry.manifest.name).versions.has(VERSION));
	});

	it('stage refuses a dirty tree, an untagged HEAD, a disagreement, and a published version', async () => {
		state.dirty = true;
		await assert.rejects(stage(context(), {}), /not clean/);
		state.dirty = false;
		state.tagCommit = 'bbb222';
		await assert.rejects(stage(context(), {}), /not the commit of the tag v0.1.0/);
		state.tagCommit = 'aaa111';
		const drifted = [
			PACKAGES[0],
			{ ...PACKAGES[1], manifest: { ...PACKAGES[1].manifest, version: '0.2.0' } },
		];
		await assert.rejects(stage(context({ packages: drifted }), {}), /versions disagree/);
		await stage(context(), {});
		await assert.rejects(stage(context(), {}), /already/);
		assert.equal(state.gateRuns, 1, 'a refusal happens before the gate');
	});

	it('stage refuses without confirmation, and asks with the names and versions', async () => {
		let asked = '';
		const confirm = async (question) => {
			asked = question;
			return false;
		};
		await assert.rejects(stage(context({ confirm }), {}), /Not confirmed/);
		assert.match(asked, /@ambionframework\/cli@0\.1\.0/);
		assert.equal(publishCalls().length, 0);
		assert.equal(state.gateRuns, 0);
	});

	it('stage needs a token unless it is a dry run', async () => {
		await assert.rejects(stage(context({ env: {} }), {}), /NODE_AUTH_TOKEN/);
	});

	it('skips the local gate only when asked', async () => {
		await stage(context(), { skipGate: true });
		assert.equal(state.gateRuns, 0);
		assert.ok(logs.some((line) => line.includes('Skipping the local gate')));
		assert.equal(publishCalls().length, PACKAGES.length);
	});

	it('a dry run needs no token and never publishes for real', async () => {
		await stage(context({ env: {} }), { dryRun: true });
		assert.equal(fake.store.size, 0);
		assert.ok(fake.requests.every((line) => line.startsWith('GET')));
		for (const call of publishCalls()) assert.ok(call.args.includes('--dry-run'));
	});

	it('never puts the token in an argument, a log line, or the config file', async () => {
		await stage(context(), { otp: '123456' });
		await promoteWithToken();
		const everything = JSON.stringify(runner.calls.map((c) => [c.command, c.args]));
		assert.ok(!everything.includes(TOKEN));
		assert.ok(!logs.join('\n').includes(TOKEN));
		const withConfig = runner.calls.filter((c) => c.configText !== undefined);
		assert.ok(
			withConfig.some((c) => c.args[0] === 'dist-tag'),
			'promote sends a config',
		);
		assert.ok(
			withConfig.some((c) => c.args[0] === 'publish'),
			'stage sends a config',
		);
		for (const call of withConfig) {
			assert.equal(
				call.configText.trim(),
				`//${new URL(fake.url).host}/:_authToken=\${NODE_AUTH_TOKEN}`,
			);
			assert.ok(!existsSync(call.configPath), 'the config file is deleted');
		}
	});

	async function promoteWithToken() {
		await promote(context(), { yes: true });
	}

	it('resumes a partial run when the registry needs a token to read', async () => {
		state.viewNeedsToken = true;
		state.failPublishOf = PACKAGES[1].manifest.name;
		await assert.rejects(stage(context(), {}), /Failed to publish/);
		state.failPublishOf = undefined;
		const before = publishCalls().length;
		await stage(context(), {});
		assert.equal(publishCalls().length - before, PACKAGES.length - 1);
		assert.ok(logs.some((line) => line.startsWith('skip')));
	});

	it('refuses a registry that is not local', async () => {
		const { defaultContext } = await import('./release.mjs');
		await assert.rejects(defaultContext(['--registry', 'https://evil.example']), /local registry/);
	});

	it('promote sets latest for every package and is idempotent', async () => {
		await stage(context(), {});
		await promote(context(), {});
		for (const entry of PACKAGES)
			assert.equal(fake.store.get(entry.manifest.name).tags.latest, VERSION);
		const before = runner.calls.filter((c) => c.args[0] === 'dist-tag').length;
		assert.equal(before, PACKAGES.length);
		await promote(context(), {});
		assert.equal(runner.calls.filter((c) => c.args[0] === 'dist-tag').length, before);
	});

	it('promote refuses a version that is not staged and passes --otp through', async () => {
		await assert.rejects(promote(context(), {}), /Run stage first/);
		await stage(context(), {});
		await promote(context(), { otp: '654321' });
		const tagCalls = runner.calls.filter((c) => c.args[0] === 'dist-tag');
		assert.ok(tagCalls.every((c) => c.args.includes('--otp') && c.args.includes('654321')));
	});

	it('verify installs with no token and a clean npm configuration', async () => {
		await stage(context(), {});
		await verify(context(), {});
		const steps = runner.calls.filter((c) => c.options.cwd?.includes('ambion-verify-'));
		assert.deepEqual(
			steps.map((c) => `${c.command} ${c.args[0]}`),
			['npm exec', 'pnpm install', 'pnpm run', 'npm install', 'node --eval'],
		);
		for (const call of steps) {
			assert.equal(call.options.env.NODE_AUTH_TOKEN, undefined);
			assert.ok(call.options.env.NPM_CONFIG_USERCONFIG);
			assert.ok(!call.options.cwd.startsWith(ROOT));
		}
		assert.ok(steps[0].args.includes(`--package=@ambionframework/cli@${VERSION}`));
	});

	it('verify refuses a version that is not on the registry', async () => {
		await assert.rejects(verify(context(), {}), /Run stage first/);
	});

	it('status prints the dist-tags of each package', async () => {
		await stage(context(), {});
		await promote(context(), { yes: true });
		logs.length = 0;
		fake.store.delete('@ambionframework/workspace');
		await status(context());
		assert.ok(logs.includes(`@ambionframework/ambion  next=${VERSION} latest=${VERSION}`));
		assert.ok(logs.includes('@ambionframework/workspace  not published'));
	});
});

describe('publish.mjs channels', () => {
	it('dev selects GitHub Packages and release selects npmjs', () => {
		assert.equal(parseOptions(['--channel', 'dev']).registry, 'https://npm.pkg.github.com');
		assert.equal(parseOptions(['--channel', 'release']).registry, 'https://registry.npmjs.org');
		assert.equal(parseOptions([]).registry, 'https://npm.pkg.github.com');
	});

	it('defaults the dist-tag by channel and lets --registry and --tag override', () => {
		assert.equal(parseOptions(['--channel', 'dev']).tag, 'dev');
		assert.equal(parseOptions(['--channel', 'release']).tag, 'next');
		const custom = parseOptions(['--registry', 'http://localhost:1', '--tag', 'x']);
		assert.equal(custom.registry, 'http://localhost:1');
		assert.equal(custom.tag, 'x');
	});

	it('refuses the latest tag on the dev channel, as the old release workflow passed it', () => {
		assert.throws(
			() => parseOptions(['--skip-pack', '--tag', 'latest']),
			/cannot publish under latest/,
		);
		assert.throws(
			() => parseOptions(['--channel', 'dev', '--tag', 'latest']),
			/cannot publish under latest/,
		);
		assert.equal(parseOptions(['--channel', 'release', '--tag', 'latest']).tag, 'latest');
	});

	it('refuses an unknown channel', () => {
		assert.throws(() => channelRegistry('beta'), /Unknown channel/);
	});

	it('a release publish without --yes stops before any npm call', async () => {
		const bin = await mkdtemp(join(tmpdir(), 'ambion-bin-'));
		try {
			await writeFile(join(bin, 'npm'), '#!/bin/sh\necho called >> "$0.log"\nexit 1\n', {
				mode: 0o755,
			});
			let message = '';
			try {
				execFileSync(
					process.execPath,
					['scripts/publish.mjs', '--channel', 'release', '--skip-pack'],
					{ cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe' },
				);
			} catch (error) {
				message = String(error.stderr);
			}
			assert.match(message, /needs --yes/);
			assert.ok(!existsSync(join(bin, 'npm.log')));
		} finally {
			await rm(bin, { recursive: true, force: true });
		}
	});
});

describe('version stamps', () => {
	it('accepts a stamped dev version and refuses a leading zero', () => {
		assert.ok(isVersion('0.1.0-dev.42.g1a2b3c4'));
		assert.ok(isVersion('0.1.0-dev.7.g0123456'));
		assert.ok(isVersion('0.1.0'));
		assert.ok(!isVersion('0.1.0-dev.042.g1a2b3c4'));
		assert.ok(!isVersion('0.1'));
	});

	it('version.mjs --check passes on the repository', () => {
		execFileSync(process.execPath, ['scripts/version.mjs', '--check'], {
			cwd: ROOT,
			stdio: 'pipe',
		});
	});
});
