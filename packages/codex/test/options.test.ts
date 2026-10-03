/**
 * What one activation passes to `codex app-server`, and the native tools
 * off: the config flags, the thread policy, the patched catalog entry, the
 * scratch directory, and the catalog of the installed binary. A hung or a
 * broken binary fails, and never opens a seat. No key, no network, no
 * `codex app-server` process.
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
import { COMPOSE_GUIDANCE, type ComposeOptions } from '@ambionframework/ambion';
import { afterAll, describe, expect, it } from 'vitest';
import { functionRuntime } from '../../ambion/test/support/compose-runtime.ts';
import {
	EXCLUSIVE_FEATURES,
	exclusiveConfig,
	exclusiveEntry,
	installedCatalog,
	Scratch,
	scratchFor,
} from '../src/catalog.ts';
import { codex } from '../src/define.ts';
import { seatHome } from '../src/home.ts';
import {
	configFlags,
	launchOf,
	processConfig,
	SEAT_NOTE,
	seatText,
	threadParams,
} from '../src/options.ts';
import { catalogFixture, recordedCatalog } from './support.ts';

const own: ComposeOptions = { runtime: functionRuntime, guidance: 'Own guidance.' };

const luna = catalogFixture.models.find((entry) => entry.slug === 'gpt-5.6-luna');
if (luna === undefined) throw new Error('The fixture lacks gpt-5.6-luna.');

describe('seatText', () => {
	it('joins the harness note, the mechanism, and the agent part, in that order', () => {
		expect(seatText({ mechanism: 'How a room works.', agent: 'Who the seat is.' })).toBe(
			`${SEAT_NOTE}\n\nHow a room works.\n\nWho the seat is.`,
		);
	});
});

describe('configFlags', () => {
	it('gives one -c flag for each leaf, with dotted keys and TOML values', () => {
		expect(
			configFlags({
				model_reasoning_summary: 'auto',
				features: { shell_tool: false, plugins: false },
				web_search: 'disabled',
				tools: { update_plan: { enabled: false } },
				limit: 3,
				names: ['a', 'b'],
			}),
		).toEqual([
			'-c',
			'model_reasoning_summary="auto"',
			'-c',
			'features.shell_tool=false',
			'-c',
			'features.plugins=false',
			'-c',
			'web_search="disabled"',
			'-c',
			'tools.update_plan.enabled=false',
			'-c',
			'limit=3',
			'-c',
			'names=["a", "b"]',
		]);
	});

	it('quotes a key with other characters than letters, digits, and dashes, and escapes a string', () => {
		expect(configFlags({ mcp_servers: { 'a.b': { command: 'a"b\n\u007f' } }, empty: {} })).toEqual([
			'-c',
			'mcp_servers."a.b".command="a\\"b\\n\\u007f"',
			'-c',
			'empty={}',
		]);
	});

	it('refuses a value with no TOML form', () => {
		expect(() => configFlags({ gone: null })).toThrow(/no TOML form/);
	});
});

describe('launchOf', () => {
	it('starts app-server with the config of the seat, and gives the binary the environment of the seat', () => {
		const scratch = new Scratch(luna);
		try {
			const home = seatHome({
				home: '/srv/seat',
				env: { PATH: '/bin', HOME: '/h', GONE: undefined },
			});
			const executor = codex({
				instructions: 'x',
				model: 'gpt-5.6-luna',
				modelReasoningEffort: 'medium',
			});
			const launch = launchOf('/bin/codex', home, executor, scratch);
			expect(launch.command).toBe('/bin/codex');
			expect(launch.args[0]).toBe('app-server');
			expect(launch.cwd).toBe(scratch.directory);
			expect(launch.env).toMatchObject({
				PATH: '/bin',
				HOME: '/srv/seat/home',
				CODEX_HOME: '/srv/seat',
			});
			expect(launch.env).not.toHaveProperty('GONE');
			const flags = launch.args.filter((flag) => flag !== '-c').slice(1);
			expect(flags).toContain('model_reasoning_effort="medium"');
			expect(flags).toContain('model_reasoning_summary="auto"');
			expect(flags).toContain(`model_catalog_json=${JSON.stringify(scratch.catalog)}`);
			// The room tools are dynamic tools of the thread, so no server entry names them.
			expect(flags).toContain('mcp_servers.node_repl.command="true"');
			expect(flags).toContain('mcp_servers.node_repl.enabled=false');
			expect(flags.some((flag) => flag.startsWith('mcp_servers.ambion'))).toBe(false);
			expect(flags.some((flag) => flag.startsWith('model_instructions_file'))).toBe(false);
		} finally {
			scratch.remove();
		}
	});

	it('leaves the effort out when the executor names none, and sends the summary of the executor', () => {
		const scratch = new Scratch(luna);
		try {
			const plain = codex({ instructions: 'x', model: 'm' });
			expect(processConfig(plain, scratch)).not.toHaveProperty('model_reasoning_effort');
			const none = codex({ instructions: 'x', model: 'm', reasoningSummary: 'none' });
			expect(processConfig(none, scratch)).toMatchObject({ model_reasoning_summary: 'none' });
		} finally {
			scratch.remove();
		}
	});
});

describe('threadParams', () => {
	it('fixes the policy for every seat, and carries the model and the seat text', () => {
		const scratch = new Scratch(luna);
		try {
			const plain = codex({ instructions: 'x', model: 'm' });
			expect(threadParams(plain, scratch, 'seat text')).toEqual({
				cwd: scratch.directory,
				sandbox: 'read-only',
				approvalPolicy: 'never',
				model: 'm',
				baseInstructions: 'seat text',
			});
		} finally {
			scratch.remove();
		}
	});

	it.each([
		['absent', undefined, ['compose', 'describe'], COMPOSE_GUIDANCE],
		['an object', own, ['compose', 'describe'], 'Own guidance.'],
	])('gives the tool list of the seat for compose %s', (_name, compose, names, guidance) => {
		const executor = codex({
			instructions: 'x',
			model: 'm',
			...(compose === undefined ? {} : { compose }),
		});
		expect(executor.tools.map((tool) => tool.name)).toEqual(names);
		expect(executor.guidance).toBe(guidance);
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

it('exclusiveConfig names the patched catalog, turns every listed feature off and only those, and disables web search, two tools, the skills, the update check, the analytics, the feedback upload, and the memories', () => {
	const config = exclusiveConfig('/tmp/models.json') as {
		model_catalog_json: string;
		features: Record<string, boolean>;
		web_search: string;
		tools: Record<string, unknown>;
		skills: Record<string, unknown>;
	};
	expect(config.model_catalog_json).toBe('/tmp/models.json');
	expect(Object.keys(config.features)).toEqual([...EXCLUSIVE_FEATURES]);
	expect(Object.values(config.features).every((on) => on === false)).toBe(true);
	for (const name of ['code_mode', 'code_mode_only', 'shell_tool', 'unified_exec']) {
		expect(config.features[name]).toBe(false);
	}
	expect(config.web_search).toBe('disabled');
	expect(config).toMatchObject({
		check_for_update_on_startup: false,
		analytics: { enabled: false },
		feedback: { enabled: false },
		memories: { generate_memories: false, use_memories: false },
	});
	expect(config.skills).toEqual({ include_instructions: false, bundled: { enabled: false } });
	expect(config.tools).toEqual({
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
