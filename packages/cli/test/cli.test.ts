import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WorkerClient } from '../src/lib/client.ts';
import { detectTemplate, parseDevArguments } from '../src/lib/dev.ts';
import { parseNewArguments } from '../src/lib/new-arguments.ts';
import { createProject, ProjectError } from '../src/lib/project.ts';
import { cliVersion } from '../src/lib/version.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('cliVersion', () => {
	it('reads the version off the CLI manifest', async () => {
		const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
			version: string;
		};
		expect(cliVersion()).toBe(manifest.version);
	});
});

describe('the bin guard', () => {
	it('enforces exactly the Node floor package.json declares', async () => {
		const bin = await readFile(join(PACKAGE_ROOT, 'bin', 'ambion.mjs'), 'utf8');
		const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
			engines: { node: string };
		};
		// bin/ambion.mjs cannot read package.json — it must parse on Node versions
		// that lack JSON import attributes — so the floor is written twice. This
		// asserts the two copies agree.
		const major = /MIN_NODE_MAJOR = (\d+)/.exec(bin)?.[1];
		const minor = /MIN_NODE_MINOR = (\d+)/.exec(bin)?.[1];
		expect(major).toBeDefined();
		expect(minor).toBeDefined();
		expect(manifest.engines.node).toBe(`>=${major}.${minor}.0`);
	});
});

describe('ambion new', () => {
	it('creates the node template by default', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-cli-'));
		const target = join(root, 'my-team');
		try {
			await createProject(target, '0.3.0');
			const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
				name: string;
				ambion: { template: string };
				dependencies: Record<string, string>;
				devDependencies: Record<string, string>;
			};
			expect(manifest.name).toBe('my-team');
			expect(manifest.ambion.template).toBe('node');
			expect(manifest.dependencies['@ambionframework/ambion']).toBe('0.3.0');
			expect(manifest.dependencies['@ambionframework/journal']).toBe('0.3.0');
			expect(manifest.dependencies['@ambionframework/pi']).toBe('0.3.0');
			expect(manifest.devDependencies['@ambionframework/cli']).toBe('0.3.0');
			expect(manifest.dependencies).not.toHaveProperty('@ambionframework/cloudflare');
			await expect(access(join(target, 'src', 'host.ts'))).resolves.toBeUndefined();
			await expect(access(join(target, 'wrangler.jsonc'))).rejects.toThrow();
			expect(await readFile(join(target, '.gitignore'), 'utf8')).toContain('.data/');
			await expect(access(join(target, '.env.example'))).resolves.toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects an unknown template', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-cli-'));
		try {
			await expect(createProject(join(root, 'a'), '0.3.0', 'fly' as never)).rejects.toThrow(
				ProjectError,
			);
			await expect(access(join(root, 'a'))).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('copies the cloudflare template and substitutes the project name and version', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-cli-'));
		const target = join(root, 'my-team');
		try {
			await createProject(target, '0.3.0', 'cloudflare');
			const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')) as {
				name: string;
				ambion: { template: string };
				dependencies: Record<string, string>;
			};
			const wrangler = JSON.parse(await readFile(join(target, 'wrangler.jsonc'), 'utf8')) as {
				name: string;
			};
			expect(manifest.name).toBe('my-team');
			expect(manifest.ambion.template).toBe('cloudflare');
			expect(manifest.dependencies['@ambionframework/ambion']).toBe('0.3.0');
			expect(manifest.dependencies['@ambionframework/cloudflare']).toBe('0.3.0');
			expect(wrangler.name).toBe('my-team');
			await expect(readFile(join(target, '.npmrc'), 'utf8')).rejects.toThrow();
			expect(await readFile(join(target, '.gitignore'), 'utf8')).toContain('.wrangler');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('refuses a non-empty target and invalid project names', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-cli-'));
		try {
			for (const template of ['node', 'cloudflare'] as const) {
				for (const name of ['Bad Name', 'with.dot', 'with_under', '-leading', 'trailing-']) {
					await expect(createProject(join(root, name), '0.3.0', template)).rejects.toThrow(
						ProjectError,
					);
				}
				await expect(createProject(join(root, 'a'.repeat(64)), '0.3.0', template)).rejects.toThrow(
					ProjectError,
				);
				const target = join(root, `existing-${template}`);
				await createProject(target, '0.3.0', template);
				await expect(createProject(target, '0.3.0', template)).rejects.toThrow(
					'Refusing to overwrite',
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe('new arguments', () => {
	it('defaults to the node template', () => {
		expect(parseNewArguments(['my-team'])).toEqual({ directory: 'my-team', template: 'node' });
	});

	it('accepts the template in both forms, before or after the directory', () => {
		const cloudflare = { directory: 'my-team', template: 'cloudflare' };
		expect(parseNewArguments(['my-team', '--template', 'cloudflare'])).toEqual(cloudflare);
		expect(parseNewArguments(['--template=cloudflare', 'my-team'])).toEqual(cloudflare);
		expect(parseNewArguments(['my-team', '--template=node']).template).toBe('node');
	});

	it('rejects a second directory, a missing directory, and a bad template', () => {
		expect(() => parseNewArguments(['a', 'b'])).toThrow('Usage');
		expect(() => parseNewArguments([])).toThrow('Usage');
		expect(() => parseNewArguments(['a', '--template'])).toThrow('Usage');
		expect(() => parseNewArguments(['a', '--other'])).toThrow('Usage');
		expect(() => parseNewArguments(['a', '--template=fly'])).toThrow("Unknown template 'fly'");
	});
});

describe('project detection', () => {
	it('reads the marker and falls back to the Wrangler file', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-cli-'));
		try {
			for (const template of ['node', 'cloudflare'] as const) {
				const target = join(root, template);
				await createProject(target, '0.3.0', template);
				await expect(detectTemplate(target)).resolves.toBe(template);
			}
			const legacy = join(root, 'legacy');
			await createProject(legacy, '0.3.0', 'cloudflare');
			await writeFile(join(legacy, 'package.json'), '{}');
			await expect(detectTemplate(legacy)).resolves.toBe('cloudflare');
			await expect(detectTemplate(join(root, 'missing'))).rejects.toThrow('not an Ambion project');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe('dev arguments and worker client', () => {
	it('parses a project directory and port', () => {
		expect(parseDevArguments(['my-team', '--port', '9000'], '/tmp')).toEqual({
			directory: '/tmp/my-team',
			port: 9000,
		});
		expect(parseDevArguments(['my-team', '--port=9001'], '/tmp').port).toBe(9001);
		expect(() => parseDevArguments(['--port', '0'])).toThrow('between 1 and 65535');
	});

	it('sends JSON requests and reports structured Worker errors', async () => {
		const requests: Request[] = [];
		const client = new WorkerClient('http://127.0.0.1:8787', async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(JSON.stringify({ from: 4, owner: 'human', at: 'now' }));
		});
		await expect(client.send('Hello team')).resolves.toMatchObject({ from: 4 });
		expect(await requests[0]?.json()).toEqual({ from: 'human', text: 'Hello team' });

		const failing = new WorkerClient(
			'http://127.0.0.1:8787',
			async () => new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }),
		);
		await expect(failing.start()).rejects.toThrow('bad request');
	});

	it('reads the room from GET /read with an exclusive cursor', async () => {
		const urls: string[] = [];
		const read = { name: 'team', initialized: true, messages: [], participants: [] };
		const client = new WorkerClient('http://127.0.0.1:8787/', async (input) => {
			urls.push(String(input));
			return new Response(JSON.stringify(read));
		});
		await expect(client.read()).resolves.toEqual(read);
		await expect(client.read({ since: 7 })).resolves.toEqual(read);
		expect(urls).toEqual(['http://127.0.0.1:8787/read', 'http://127.0.0.1:8787/read?since=7']);
	});
});
