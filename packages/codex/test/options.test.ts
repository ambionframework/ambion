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
import { ROOM_SERVER } from '@ambionframework/ambion/hosting';
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
import { seatHome } from '../src/home.ts';
import {
	clientOptions,
	HARNESS_NOTE,
	seatText,
	serverPath,
	threadOptions,
} from '../src/options.ts';
import { catalogFixture, recordedCatalog } from './support.ts';

const luna = catalogFixture.models.find((entry) => entry.slug === 'gpt-5.6-luna');
if (luna === undefined) throw new Error('The fixture lacks gpt-5.6-luna.');

describe('seatText', () => {
	it('joins the harness note, the mechanism, and the agent part, in that order', () => {
		expect(seatText({ mechanism: 'How a room works.', agent: 'Who the seat is.' })).toBe(
			`${HARNESS_NOTE}\n\nHow a room works.\n\nWho the seat is.`,
		);
	});
});

describe('clientOptions', () => {
	it('names the instructions file, adds the config, and disables node_repl beside the approved room server', () => {
		const scratch = new Scratch(luna, 'seat text');
		try {
			const config = clientOptions({}, seatHome({}), '/tmp/room.sock', 'auto', scratch).config as {
				model_catalog_json: string;
				model_instructions_file: string;
				model_reasoning_summary: string;
				mcp_servers: Record<
					string,
					{
						enabled?: boolean;
						required?: boolean;
						command: string;
						default_tools_approval_mode?: string;
						args: string[];
					}
				>;
			};
			expect(config).not.toHaveProperty('developer_instructions');
			expect(config.model_instructions_file).toBe(scratch.instructions);
			expect(config.model_catalog_json).toBe(scratch.catalog);
			expect(config.model_reasoning_summary).toBe('auto');
			expect(config.mcp_servers[NODE_REPL]).toEqual({ command: 'true', enabled: false });
			expect(Object.keys(config.mcp_servers)).toHaveLength(2);
			const room = config.mcp_servers[ROOM_SERVER];
			expect(room?.default_tools_approval_mode).toBe('approve');
			// Codex then waits for the server before the first model request.
			expect(room?.required).toBe(true);
			expect(room?.args.at(-1)).toBe('/tmp/room.sock');
		} finally {
			scratch.remove();
		}
	});
});

describe('clientOptions environment', () => {
	it('gives the binary the environment of the execution with the home of the seat', () => {
		const home = seatHome({
			home: '/srv/seat',
			env: { PATH: '/bin', HOME: '/h', GONE: undefined },
		});
		const scratch = new Scratch(luna, 'seat text');
		try {
			expect(
				clientOptions({ codexPath: '/bin/codex' }, home, '/tmp/room.sock', 'auto', scratch),
			).toMatchObject({
				codexPathOverride: '/bin/codex',
				env: { PATH: '/bin', HOME: '/h', CODEX_HOME: '/srv/seat' },
			});
			expect(clientOptions({}, home, '/tmp/room.sock', 'auto', scratch).env).not.toHaveProperty(
				'GONE',
			);
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
	it('fixes the policy for every seat, and passes only the reasoning effort of the executor', () => {
		const scratch = new Scratch(luna, 'seat text');
		try {
			const fixed = {
				model: 'm',
				sandboxMode: 'read-only',
				approvalPolicy: 'never',
				networkAccessEnabled: false,
				workingDirectory: scratch.directory,
				skipGitRepoCheck: true,
			};
			const plain = codex({ instructions: 'x', model: 'm' });
			expect(threadOptions(plain, scratch)).toEqual(fixed);
			const effort = codex({ instructions: 'x', model: 'm', modelReasoningEffort: 'medium' });
			expect(threadOptions(effort, scratch)).toEqual({ ...fixed, modelReasoningEffort: 'medium' });
		} finally {
			scratch.remove();
		}
	});

	it('defaults reasoningSummary to auto', () => {
		expect(codex({ instructions: 'x', model: 'm' }).reasoningSummary).toBe('auto');
		expect(
			codex({ instructions: 'x', model: 'm', reasoningSummary: 'none' }).reasoningSummary,
		).toBe('none');
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
			supports_search_tool: false,
			experimental_supported_tools: [],
			node_repl_disabled: true,
			multi_agent_version: null,
			include_apps_usage_instructions: false,
			include_plugin_usage_instructions: false,
			include_skills_usage_instructions: false,
		});
		// The model keeps its own image input, so an image from a tool of the seat reaches it.
		expect(luna.input_modalities).toEqual(['text', 'image']);
		expect(patched.input_modalities).toEqual(luna.input_modalities);
		expect(patched.supports_image_detail_original).toBe(luna.supports_image_detail_original);
		expect(patched.base_instructions).toBe(luna.base_instructions);
		expect(patched.context_window).toBe(luna.context_window);
		expect(luna).toEqual(before);
		expect(luna.tool_mode).toBe('code_mode_only');
		expect(patched).not.toBe(luna);
	});

	it('keeps the modalities of a model with no image input', () => {
		const textOnly = { ...luna, input_modalities: ['text'], supports_image_detail_original: false };
		expect(exclusiveEntry(textOnly)).toMatchObject({
			input_modalities: ['text'],
			supports_image_detail_original: false,
		});
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
	it('holds the patched catalog, the seat text, and an empty directory, and removes all', () => {
		const scratch = new Scratch(luna, 'seat text');
		const stored = JSON.parse(readFileSync(scratch.catalog, 'utf8')) as { models: unknown[] };
		expect(stored.models).toEqual([exclusiveEntry(luna)]);
		expect(readFileSync(scratch.instructions, 'utf8')).toBe('seat text');
		expect(readdirSync(scratch.directory)).toEqual([]);
		scratch.remove();
		expect(existsSync(scratch.catalog)).toBe(false);
		expect(existsSync(scratch.instructions)).toBe(false);
		expect(existsSync(scratch.directory)).toBe(false);
		scratch.remove();
	});

	it('fails for a model that the catalog lacks, and names the model', async () => {
		await expect(scratchFor('gpt-unknown', recordedCatalog, 'seat text')).rejects.toThrow(
			/'gpt-unknown'.*a Codex seat needs/,
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
			{},
		);
		expect(await source('m2')).toMatchObject({ slug: 'm2' });
		expect(await source('absent')).toBeUndefined();
	});

	it('gives up on a binary that does not answer in time', async () => {
		const path = binary('hang', 'sleep 30');
		const started = Date.now();
		await expect(installedCatalog(path, {}, 200)('m1')).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it('keeps one catalog for each home of the same binary', async () => {
		const path = binary('homes', `echo "{\\"models\\":[{\\"slug\\":\\"$CODEX_HOME\\"}]}"`);
		const one = installedCatalog(path, { CODEX_HOME: '/homes/one' });
		const two = installedCatalog(path, { CODEX_HOME: '/homes/two' });
		expect(await one('/homes/one')).toBeDefined();
		expect(await two('/homes/two')).toBeDefined();
		expect(await two('/homes/one')).toBeUndefined();
	});

	it('fails with a message when the binary prints no JSON, then tries again and does not keep the failed run', async () => {
		const path = binary('flaky', 'echo not json');
		await expect(installedCatalog(path, {})('m1')).rejects.toThrow(/not JSON/);
		writeFileSync(path, `#!/bin/sh\necho '{"models":[{"slug":"m1"}]}'\n`);
		expect(await installedCatalog(path, {})('m1')).toMatchObject({ slug: 'm1' });
	});
});
