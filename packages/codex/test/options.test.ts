/**
 * What one activation passes to the Codex client, and the native tools off:
 * the room server, the thread policy, the patched catalog entry, the client
 * config, the scratch directory, and the catalog of the installed binary. A
 * hung or a broken binary fails, and never opens a seat. No key, no
 * network, no `codex` process.
 */
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
	EXCLUSIVE_FEATURES,
	exclusiveConfig,
	exclusiveEntry,
	installedCatalog,
	NODE_REPL,
	Scratch,
	scratchFor,
} from '../src/catalog.ts';
import { codex } from '../src/define.ts';
import { clientOptions, serverPath, threadOptions } from '../src/options.ts';
import { catalogFixture, recordedCatalog } from './support.ts';

const luna = catalogFixture.models.find((entry) => entry.slug === 'gpt-5.6-luna');
if (luna === undefined) throw new Error('The fixture lacks gpt-5.6-luna.');

describe('clientOptions', () => {
	it('serves only the approved room server, with the socket path, without a scratch', () => {
		const config = clientOptions({}, '/tmp/room.sock').config as {
			mcp_servers: Record<string, { default_tools_approval_mode?: string; args: string[] }>;
		};
		expect(Object.keys(config)).toEqual(['mcp_servers']);
		const servers = Object.values(config.mcp_servers);
		expect(servers).toHaveLength(1);
		expect(servers[0]?.default_tools_approval_mode).toBe('approve');
		expect(servers[0]?.args.at(-1)).toBe('/tmp/room.sock');
	});

	it('adds the config and disables node_repl beside the room server with a scratch', () => {
		const scratch = new Scratch(luna);
		try {
			const config = clientOptions({}, '/tmp/room.sock', scratch).config as {
				model_catalog_json: string;
				mcp_servers: Record<string, { enabled?: boolean; command: string }>;
			};
			expect(config.model_catalog_json).toBe(scratch.catalog);
			expect(config.mcp_servers[NODE_REPL]).toEqual({ command: 'true', enabled: false });
			expect(Object.keys(config.mcp_servers)).toHaveLength(2);
		} finally {
			scratch.remove();
		}
	});
});

describe('serverPath', () => {
	it('names the TypeScript server in the source tree, and the built server beside a built module', () => {
		const path = serverPath();
		expect(path.endsWith('/src/room-tools-server.ts')).toBe(true);
		expect(existsSync(path)).toBe(true);
		expect(serverPath('file:///app/node_modules/@ambionframework/codex/dist/index.mjs')).toBe(
			'/app/node_modules/@ambionframework/codex/dist/room-tools-server.mjs',
		);
	});

	it('names an existing built file when the package is built', () => {
		const built = new URL('../dist/index.mjs', import.meta.url);
		if (!existsSync(fileURLToPath(built))) return;
		const path = serverPath(built);
		expect(path.endsWith('/dist/room-tools-server.mjs')).toBe(true);
		expect(existsSync(path)).toBe(true);
	});
});

describe('threadOptions', () => {
	const policy = {
		sandboxMode: 'danger-full-access',
		approvalPolicy: 'on-request',
		networkAccessEnabled: true,
		workingDirectory: '/home/me',
		modelReasoningEffort: 'medium',
	} as const;
	const executor = codex({ instructions: 'x', model: 'm', ...policy });

	it('applies the options as they are without a scratch, and fixes the policy under a scratch', () => {
		expect(threadOptions(executor)).toMatchObject(policy);
		const scratch = new Scratch(luna);
		try {
			expect(threadOptions(executor, scratch)).toMatchObject({
				sandboxMode: 'read-only',
				approvalPolicy: 'never',
				networkAccessEnabled: false,
				workingDirectory: scratch.directory,
				modelReasoningEffort: 'medium',
			});
		} finally {
			scratch.remove();
		}
	});

	it('defaults nativeTools to none', () => {
		expect(codex({ instructions: 'x', model: 'm' }).nativeTools).toBe('none');
		expect(codex({ instructions: 'x', model: 'm', nativeTools: 'codex' }).nativeTools).toBe(
			'codex',
		);
	});
});

describe('exclusiveEntry', () => {
	it('removes every native tool from the recorded entry, keeps every other field, and leaves the input entry as it was', () => {
		const before = structuredClone(luna);
		const patched = exclusiveEntry(luna);
		expect(patched).toMatchObject({
			slug: 'gpt-5.6-luna',
			tool_mode: null,
			apply_patch_tool_type: null,
			input_modalities: ['text'],
			supports_search_tool: false,
			experimental_supported_tools: [],
			node_repl_disabled: true,
			multi_agent_version: null,
			supports_image_detail_original: false,
			include_apps_usage_instructions: false,
			include_plugin_usage_instructions: false,
			include_skills_usage_instructions: false,
		});
		expect(patched.base_instructions).toBe(luna.base_instructions);
		expect(patched.context_window).toBe(luna.context_window);
		expect(luna).toEqual(before);
		expect(luna.tool_mode).toBe('code_mode_only');
		expect(patched).not.toBe(luna);
	});

	it('patches the entry of a model that has no tool mode', () => {
		const other = catalogFixture.models.find((entry) => entry.slug === 'gpt-5.5');
		expect(other?.tool_mode ?? null).toBeNull();
		expect(exclusiveEntry(other ?? luna).node_repl_disabled).toBe(true);
	});
});

it('exclusiveConfig names the patched catalog, turns every listed feature off and only those, and disables web search and three tools', () => {
	const config = exclusiveConfig('/tmp/models.json') as {
		model_catalog_json: string;
		features: Record<string, boolean>;
		web_search: string;
		tools: Record<string, unknown>;
	};
	expect(config.model_catalog_json).toBe('/tmp/models.json');
	expect(Object.keys(config.features)).toEqual([...EXCLUSIVE_FEATURES]);
	expect(Object.values(config.features).every((on) => on === false)).toBe(true);
	for (const name of ['code_mode', 'code_mode_only', 'shell_tool', 'unified_exec']) {
		expect(config.features[name]).toBe(false);
	}
	expect(config.web_search).toBe('disabled');
	expect(config.tools).toEqual({
		view_image: false,
		update_plan: { enabled: false },
		experimental_request_user_input: { enabled: false },
	});
});

describe('Scratch', () => {
	it('holds the patched catalog and an empty directory, and removes both', () => {
		const scratch = new Scratch(luna);
		const stored = JSON.parse(readFileSync(scratch.catalog, 'utf8')) as { models: unknown[] };
		expect(stored.models).toEqual([exclusiveEntry(luna)]);
		expect(readdirSync(scratch.directory)).toEqual([]);
		scratch.remove();
		expect(existsSync(scratch.catalog)).toBe(false);
		expect(existsSync(scratch.directory)).toBe(false);
		scratch.remove();
	});

	it('fails for a model that the catalog lacks, and names the model', async () => {
		await expect(scratchFor('gpt-unknown', recordedCatalog)).rejects.toThrow(
			/'gpt-unknown'.*nativeTools 'none' needs/,
		);
	});
});

describe('installedCatalog', () => {
	const directory = mkdtempSync(join(tmpdir(), 'ambion-codex-catalog-'));
	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	/** An executable shell script that stands for the `codex` binary. */
	function binary(name: string, body: string): string {
		const path = join(directory, name);
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
		return path;
	}

	it('reads the entry of a model from the binary', async () => {
		const source = installedCatalog(
			binary('ok', `echo '{"models":[{"slug":"m1"},{"slug":"m2"}]}'`),
			undefined,
		);
		expect(await source('m2')).toMatchObject({ slug: 'm2' });
		expect(await source('absent')).toBeUndefined();
	});

	it('gives up on a binary that does not answer in time', async () => {
		const path = binary('hang', 'sleep 30');
		const started = Date.now();
		await expect(installedCatalog(path, undefined, 200)('m1')).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it('fails with a message when the binary prints no JSON, then tries again and does not keep the failed run', async () => {
		const path = binary('flaky', 'echo not json');
		await expect(installedCatalog(path, undefined)('m1')).rejects.toThrow(/not JSON/);
		writeFileSync(path, `#!/bin/sh\necho '{"models":[{"slug":"m1"}]}'\n`);
		expect(await installedCatalog(path, undefined)('m1')).toMatchObject({ slug: 'm1' });
	});
});
