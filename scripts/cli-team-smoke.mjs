#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
/** Check a packed CLI in a project outside the repository. */
import { chmod, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT } from './packages.mjs';

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`);
}

function capture(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

async function providerKey() {
	try {
		const key = (await readFile(resolve(homedir(), '.anthropic/dev-key'), 'utf8')).trim();
		return key === '' ? undefined : key;
	} catch {
		return undefined;
	}
}

async function writeCredential(destination, live) {
	if (!live) return undefined;
	const key = await providerKey();
	if (key === undefined) throw new Error('Cannot run --live without ~/.anthropic/dev-key.');
	const path = join(destination, '.dev.vars');
	await writeFile(path, `ANTHROPIC_API_KEY=${key}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
	return path;
}

async function packFixture(destination) {
	await mkdir(destination);
	const archiveDirectory = join(destination, '.ambion-packages');
	await mkdir(archiveDirectory);
	run('pnpm', ['build'], ROOT);
	const archives = {};
	for (const name of [
		'journal',
		'pi-journal',
		'ambion',
		'pi',
		'claude',
		'codex',
		'assistant',
		'workspace',
		'cloudflare',
		'cli',
	]) {
		const directory = join(ROOT, 'packages', name);
		const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
		run('pnpm', ['pack', '--pack-destination', archiveDirectory], directory);
		archives[manifest.name] =
			`${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
	}
	const overrides = Object.fromEntries(
		Object.entries(archives).map(([name, filename]) => [name, `file:.ambion-packages/${filename}`]),
	);
	await writeFile(
		join(destination, 'package.json'),
		`${JSON.stringify(
			{
				name: 'ambion-packed-consumer',
				version: '0.0.0',
				private: true,
				type: 'module',
				packageManager: 'pnpm@10.20.0',
				scripts: { 'check:types': 'tsc --noEmit' },
				dependencies: Object.fromEntries(
					Object.entries(archives).map(([name, filename]) => [
						name,
						`file:.ambion-packages/${filename}`,
					]),
				),
				devDependencies: {
					'@types/node': '26.2.0',
					// The package README examples import typebox, which a consumer installs.
					typebox: '^1.3.18',
					typescript: '7.0.2',
				},
				pnpm: { overrides },
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(
		join(destination, 'tsconfig.json'),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2022',
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					strict: true,
					noEmit: true,
					skipLibCheck: true,
				},
				include: ['src'],
			},
			null,
			2,
		)}\n`,
	);
	await mkdir(join(destination, 'src'));
	await writeFile(
		join(destination, 'src', 'index.ts'),
		"import { PACKAGE_NAME, readExchange } from '@ambionframework/ambion';\nimport type { ExchangeRef, Room } from '@ambionframework/ambion';\nimport type { Env } from '@ambionframework/cloudflare';\n\nconst name: string = PACKAGE_NAME;\nconst env: Env | undefined = undefined;\ndeclare const room: Room;\ndeclare const exchange: ExchangeRef;\nconst snapshot = room.read({ messages: false });\nconst handle = room.exchange(exchange.from);\nif (handle !== undefined) {\n  void handle.waitForClose();\n  void handle.waitForSummary();\n}\nvoid readExchange('room', exchange.from);\nvoid snapshot;\nvoid name;\nvoid env;\n",
	);
	await writeFile(
		join(destination, 'src', 'transport.ts'),
		`import {
  assertWire,
  inProcessTransport,
  roundTrip,
  type EndReason,
  type AgentExecutionContext,
  type RoomProtocol,
  type Transport,
} from '@ambionframework/ambion/hosting';

// @ts-expect-error Persisted exchange events are internal.
import type { Close } from '@ambionframework/ambion/hosting';
// @ts-expect-error Stored configuration is internal.
import type { Composition } from '@ambionframework/ambion/hosting';
// @ts-expect-error Run fences are internal.
import type { Fence } from '@ambionframework/ambion/hosting';
// @ts-expect-error Stored lease events are internal.
import type { LeaseChange } from '@ambionframework/ambion/hosting';
// @ts-expect-error Projected lease state is internal.
import type { LeaseHold } from '@ambionframework/ambion/hosting';
// @ts-expect-error Stored membership is internal.
import type { Seating } from '@ambionframework/ambion/hosting';

const local = inProcessTransport();
export const transport: Transport = {
  connect(room: RoomProtocol, context: AgentExecutionContext) {
    const calls: RoomProtocol = {
      view: async (activation) => roundTrip(await room.view(activation)),
      commit: async (request) => {
        assertWire(request);
        return roundTrip(await room.commit(roundTrip(request)));
      },
      lease: async (request) => roundTrip(await room.lease(roundTrip(request))),
    };
    const port = local.connect(calls, context);
    return {
      wake: (wake) => port.wake(roundTrip(wake)),
      steer: (steer) => port.steer(roundTrip(steer)),
      cut: (activation) => port.cut(activation),
    };
  },
};

export function release(room: RoomProtocol, activation: string, readThrough: number) {
  const reason: EndReason = 'released';
  return room.lease({ activation, operation: 'release', reason, readThrough });
}
`,
	);
	await workspaceFixture(destination);
	await assistantFixture(destination);
	await readmeFixture(destination);
	return archives;
}

/** Return every fenced ts block of a Markdown page, in document order. */
export function readmeCodeBlocks(markdown) {
	return [...markdown.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
}

/**
 * Group the ts blocks of a page into modules. Blocks join into one module,
 * except that a block after the `<!-- ts: standalone -->` marker starts its own.
 */
export function readmeModules(markdown) {
	const marker = '<!-- ts: standalone -->\n\n';
	const modules = [];
	for (const match of markdown.matchAll(/^```ts\n([\s\S]*?)^```$/gm)) {
		const own = markdown.slice(0, match.index).endsWith(marker);
		if (own || modules.length === 0) modules.push([match[1]]);
		else modules[modules.length - 1].push(match[1]);
	}
	return modules.map((blocks) => blocks.join('\n'));
}

/** Typecheck the README examples. The fixture extracts them; nothing is copied by hand. */
async function readmeFixture(destination) {
	const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
	const modules = readmeModules(readme);
	if (modules.length === 0) throw new Error('README.md holds no ts block to typecheck.');
	for (const [index, source] of modules.entries()) {
		await writeFile(
			join(destination, 'src', index === 0 ? 'readme.ts' : `readme-${index}.ts`),
			source,
		);
	}
	for (const name of PACKAGE_READMES) {
		const page = await readFile(join(ROOT, 'packages', name, 'README.md'), 'utf8');
		for (const [index, block] of readmeCodeBlocks(page).entries()) {
			await writeFile(join(destination, 'src', `readme-${name}-${index}.ts`), block);
		}
	}
}

/** The package READMEs whose ts blocks are whole modules over packed exports. */
const PACKAGE_READMES = ['ambion', 'workspace', 'pi'];

/** Exercise the assistant factory and shorthand through packed exports. */
async function assistantFixture(destination) {
	await writeFile(
		join(destination, 'src', 'assistant.ts'),
		`import assert from 'node:assert/strict';
import { createRuntime, defineAgent, resumeRoom, startRoom, type AgentDefinition } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import { defineAssistant } from '@ambionframework/assistant';

const assistant: AgentDefinition = defineAssistant({
  name: 'coordinator',
  model: 'test/model',
  instructions: 'Retain all specialists across exchanges.',
});
const specialist = defineAgent({
  name: 'specialist', identity: 'Checks facts.',
  executor: pi({ instructions: 'Check facts.', model: 'test/model' }),
});
const runtime = createRuntime();
const room = await startRoom({
  name: 'packed-assistant', assistant, agents: [specialist], seats: {}, runtime,
});
try {
  assert.deepEqual((await room.read()).participants.map((seat) => seat.name), ['coordinator']);
} finally {
  await room.stop();
}
const resumed = await resumeRoom('packed-assistant', { runtime, agents: [assistant, specialist] });
try {
  assert.deepEqual((await resumed.read()).participants.map((seat) => seat.name), ['coordinator']);
} finally {
  await resumed.stop();
}
`,
	);
}

/** Exercise the resource entry and the existing facade from packed declarations and code. */
async function workspaceFixture(destination) {
	await writeFile(
		join(destination, 'src', 'workspace.ts'),
		`import { openWorkspace, memoryBackend, type Workspace, type WorkspaceBackend } from '@ambionframework/workspace';
import { openResource, type ResourceBackend, type WorkspaceResource } from '@ambionframework/workspace/resource';
import type { ToolBundle } from '@ambionframework/ambion';

const backend: WorkspaceBackend = memoryBackend();
const workspace: Workspace = openWorkspace({ name: 'facade', backend });
const tools: ToolBundle = workspace.tools();
const plainBackend: ResourceBackend = {
  connect: (agent, signal) => backend.connect(agent, signal),
  destroy: () => backend.destroy(),
};
const resource: WorkspaceResource = openResource({ name: 'plain', backend: plainBackend });
// @ts-expect-error A resource has no Ambion tool adapter.
resource.tools();
void tools;
`,
	);
	await writeFile(
		join(destination, 'workspace.mjs'),
		`import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@ambionframework/ambion' || specifier.startsWith('@ambionframework/ambion/')) {
      throw new Error('Resource loaded the collaboration runtime');
    }
    return nextResolve(specifier, context);
  },
});
await assert.rejects(import('@ambionframework/ambion'), /Resource loaded/);
const { openResource } = await import('@ambionframework/workspace/resource');
hooks.deregister();
const { openWorkspace, memoryBackend, directoryBackend } = await import('@ambionframework/workspace');
const agent = { name: 'writer', identity: 'Writes files' };
const memory = openResource({ name: 'memory', backend: memoryBackend() });
assert.equal('tools' in memory, false);
await memory.use(agent, async (env) => {
  const written = await env.writeFile('note.txt', 'shared data', {});
  assert.equal(written.ok, true);
});
await memory.use(agent, async (env) => {
  const read = await env.readTextFile('note.txt', {});
  assert.equal(read.ok, true);
  assert.equal(read.value, 'shared data');
});
await memory.destroy();
await assert.rejects(memory.use(agent, () => {}), /no longer available/i);

const root = await mkdtemp(join(tmpdir(), 'ambion-packed-resource-'));
try {
  const directory = openResource({ name: 'directory', backend: directoryBackend(root) });
  await directory.use(agent, async (env) => {
    const written = await env.writeFile('note.txt', 'persisted data', {});
    assert.equal(written.ok, true);
  });
  await directory.dispose();
  assert.equal(await readFile(join(root, 'home/writer/note.txt'), 'utf8'), 'persisted data');
  await assert.rejects(directory.use(agent, () => {}), /no longer available/i);
  const reopened = openResource({ name: 'directory', backend: directoryBackend(root) });
  await reopened.destroy();
  await assert.rejects(readFile(join(root, 'home/writer/note.txt')), { code: 'ENOENT' });
} finally {
  await rm(root, { recursive: true, force: true });
}

const workspace = openWorkspace({ name: 'facade', backend: memoryBackend() });
assert.equal(workspace.tools(), workspace.tools());
assert.deepEqual(workspace.tools().tools.map((tool) => tool.name), ['read', 'write', 'edit', 'bash', 'sql']);
await workspace.dispose();
console.log('Packed workspace resource and facade passed.');
`,
	);
}

async function installAndCheck(destination, archives) {
	const manifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
	if (JSON.stringify(manifest).includes('workspace:'))
		throw new Error('The packed consumer contains a workspace dependency.');
	for (const [name, filename] of Object.entries(archives)) {
		const packed = capture(
			'tar',
			['-xOf', join(destination, '.ambion-packages', filename), 'package/package.json'],
			destination,
		);
		if (packed.status !== 0 || packed.output.includes('workspace:'))
			throw new Error(`Packed ${name} contains a workspace dependency.`);
	}
	run('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile=false'], destination);
	run('pnpm', ['check:types'], destination);
	run(process.execPath, ['workspace.mjs'], destination);
	run(process.execPath, ['src/assistant.ts'], destination);
	const version = capture('pnpm', ['exec', 'ambion', '--version'], destination);
	if (version.status !== 0 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n?$/.test(version.output))
		throw new Error(`The packed CLI did not report a version: ${version.output}`);
}

const RESTART_SCRIPT = `import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byAgent, quiet, scripted, speak } from '@ambionframework/pi/testing';
import { openHost } from './src/host.ts';

const stream = scripted(byAgent({ planner: (_context, _agent, call) => (call === 1 ? speak('Begin.') : quiet()) }));
const directory = await mkdtemp(join(tmpdir(), 'ambion-node-restart-'));
try {
  const first = await openHost({ directory, stream });
  await first.join();
  const sent = await first.send('Does a restart keep this?');
  for (let wait = 0; wait < 100; wait += 1) {
    const exchange = (await first.read()).exchanges.find((item) => item.from === sent.from);
    if (exchange?.status === 'closed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await first.close();
  const second = await openHost({ directory, stream });
  const read = await second.read();
  await second.close();
  assert.ok(read.messages.some((message) => message.kind === 'said' && message.text === 'Does a restart keep this?'));
  console.log('Packed node project restart passed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
`;

async function checkNewCommand(destination, target, archives, template) {
	const created = capture(
		'pnpm',
		['exec', 'ambion', 'new', target, '--template', template],
		destination,
	);
	if (created.status !== 0 || !created.output.includes(`Created ${target}`))
		throw new Error(`The CLI could not create a ${template} project: ${created.output}`);
	const generatedPath = join(target, 'package.json');
	const generated = JSON.parse(await readFile(generatedPath, 'utf8'));
	if (JSON.stringify(generated).includes('workspace:'))
		throw new Error(`The new ${template} project contains a workspace dependency.`);
	if (generated.ambion?.template !== template)
		throw new Error(`The new ${template} project has the wrong template marker.`);
	if (existsSync(join(target, '.npmrc')))
		throw new Error('The new project carries a registry configuration.');
	if (template === 'cloudflare') await checkCloudflareFiles(target);
	const overwrite = capture('pnpm', ['exec', 'ambion', 'new', target], destination);
	if (overwrite.status === 0 || !overwrite.output.includes('overwrite'))
		throw new Error('The CLI accepted an existing project directory.');
	await installCreatedProject(destination, target, generated, generatedPath, archives);
	if (template === 'cloudflare') run('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run'], target);
	else await checkNodeRestart(target);
}

async function checkCloudflareFiles(target) {
	const wrangler = JSON.parse(await readFile(join(target, 'wrangler.jsonc'), 'utf8'));
	const bindings = wrangler.durable_objects?.bindings;
	if (
		!Array.isArray(bindings) ||
		!bindings.some((binding) => binding.name === 'ROOM' && binding.class_name === 'RoomObject') ||
		!bindings.some((binding) => binding.name === 'SEAT' && binding.class_name === 'SeatObject')
	)
		throw new Error('The new project is missing its Cloudflare Durable Object bindings.');
}

/** Open the packed Node project, ask a question, close it, and read it again after a reopen. */
async function checkNodeRestart(target) {
	await writeFile(join(target, 'restart-check.mjs'), RESTART_SCRIPT);
	run(process.execPath, ['restart-check.mjs'], target);
}

async function installCreatedProject(destination, target, generated, generatedPath, archives) {
	const overrides = Object.fromEntries(
		[
			'@ambionframework/ambion',
			'@ambionframework/cloudflare',
			'@ambionframework/cli',
			'@ambionframework/journal',
			'@ambionframework/pi',
			'@ambionframework/pi-journal',
		].map((name) => {
			const filename = archives[name];
			if (filename === undefined) throw new Error(`No local archive exists for ${name}.`);
			return [name, `file:.ambion-packages/${filename}`];
		}),
	);
	await cp(join(destination, '.ambion-packages'), join(target, '.ambion-packages'), {
		recursive: true,
	});
	for (const section of [generated.dependencies, generated.devDependencies]) {
		for (const name of Object.keys(section ?? {})) {
			if (overrides[name]) section[name] = overrides[name];
		}
	}
	generated.pnpm = { ...generated.pnpm, overrides };
	await writeFile(generatedPath, `${JSON.stringify(generated, null, '\t')}\n`);
	run('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile=false'], target);
	run('pnpm', ['check:types'], target);
}

async function smoke() {
	const parent = await mkdtemp(join(tmpdir(), 'ambion-team-smoke-'));
	const destination = join(parent, 'team');
	const live = process.argv.includes('--live');
	const keep = process.argv.includes('--keep');
	let credentialPath;
	try {
		const archives = await packFixture(destination);
		await installAndCheck(destination, archives);
		for (const template of ['node', 'cloudflare']) {
			const created = join(parent, `created-${template}`);
			await checkNewCommand(destination, created, archives, template);
			if (live && template === 'cloudflare') {
				credentialPath = await writeCredential(created, live);
				run('pnpm', ['exec', 'ambion', 'dev'], created);
			}
		}
		console.log(`Packed consumer smoke passed: ${destination}`);
	} finally {
		if (credentialPath) await unlink(credentialPath).catch(() => undefined);
		if (!keep) await rm(parent, { recursive: true, force: true });
	}
}

smoke().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
