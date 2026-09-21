/**
 * Native tools off: the patch of a catalog entry, the client config, the
 * scratch directory, and the failure of a model that has no entry. No key,
 * no network, no `codex` process.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	EXCLUSIVE_FEATURES,
	exclusiveConfig,
	exclusiveEntry,
	NODE_REPL,
	Scratch,
	scratchFor,
} from '../src/catalog.ts';
import { codex } from '../src/define.ts';
import { clientOptions, threadOptions } from '../src/options.ts';
import { recorded } from './fixtures.ts';
import { catalogFixture, open, recordedCatalog, seat, viewOf } from './support.ts';

const luna = catalogFixture.models.find((entry) => entry.slug === 'gpt-5.6-luna');
if (luna === undefined) throw new Error('The fixture lacks gpt-5.6-luna.');

describe('exclusiveEntry', () => {
	it('removes every native tool from the recorded entry', () => {
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
	});

	it('keeps every other field', () => {
		const patched = exclusiveEntry(luna);
		expect(patched.base_instructions).toBe(luna.base_instructions);
		expect(patched.context_window).toBe(luna.context_window);
	});

	it('leaves the input entry as it was', () => {
		const before = structuredClone(luna);
		const patched = exclusiveEntry(luna);
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

describe('exclusiveConfig', () => {
	const config = exclusiveConfig('/tmp/models.json') as {
		model_catalog_json: string;
		features: Record<string, boolean>;
		web_search: string;
		tools: Record<string, unknown>;
	};

	it('names the patched catalog', () => {
		expect(config.model_catalog_json).toBe('/tmp/models.json');
	});

	it('turns every listed feature off, and only those', () => {
		expect(Object.keys(config.features)).toEqual([...EXCLUSIVE_FEATURES]);
		expect(Object.values(config.features).every((on) => on === false)).toBe(true);
		for (const name of ['code_mode', 'code_mode_only', 'shell_tool', 'unified_exec']) {
			expect(config.features[name]).toBe(false);
		}
	});

	it('disables web search and three tools', () => {
		expect(config.web_search).toBe('disabled');
		expect(config.tools).toEqual({
			view_image: false,
			update_plan: { enabled: false },
			experimental_request_user_input: { enabled: false },
		});
	});
});

describe('clientOptions with a scratch', () => {
	it('adds the config and disables node_repl beside the room server', () => {
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

	it('adds nothing without a scratch', () => {
		const config = clientOptions({}, '/tmp/room.sock').config as Record<string, unknown>;
		expect(Object.keys(config)).toEqual(['mcp_servers']);
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

	it('fixes the policy under a scratch and ignores the options', () => {
		const scratch = new Scratch(luna);
		try {
			const options = threadOptions(codex({ instructions: 'x', model: 'm', ...policy }), scratch);
			expect(options).toMatchObject({
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

	it('applies the options as they are without a scratch', () => {
		const options = threadOptions(codex({ instructions: 'x', model: 'm', ...policy }));
		expect(options).toMatchObject(policy);
	});
});

describe('codex()', () => {
	it('defaults nativeTools to none', () => {
		expect(codex({ instructions: 'x', model: 'm' }).nativeTools).toBe('none');
		expect(codex({ instructions: 'x', model: 'm', nativeTools: 'codex' }).nativeTools).toBe(
			'codex',
		);
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

describe('the executor', () => {
	const input = { kind: 'view', view: viewOf() } as never;

	it('runs a seat under the exclusive recipe by default, and removes the scratch on close', async () => {
		const room = open([recorded('plain-answer')]);
		const session = room.activate();
		const result = await session.pass(input);
		const config = room.seen.clients[0]?.config as { model_catalog_json: string };
		const thread = room.seen.threads[0];
		expect(result).toEqual({ failed: false });
		expect(existsSync(config.model_catalog_json)).toBe(true);
		expect(thread?.workingDirectory && readdirSync(thread.workingDirectory)).toEqual([]);
		expect(thread?.sandboxMode).toBe('read-only');
		session.close?.();
		expect(existsSync(config.model_catalog_json)).toBe(false);
	});

	it('leaves the client config alone with nativeTools codex', async () => {
		const room = open(
			[recorded('plain-answer')],
			seat({ nativeTools: 'codex', sandboxMode: 'workspace-write' }),
		);
		const session = room.activate();
		await session.pass(input);
		session.close?.();
		expect(Object.keys(room.seen.clients[0]?.config ?? {})).toEqual(['mcp_servers']);
		expect(room.seen.threads[0]?.sandboxMode).toBe('workspace-write');
	});

	it('does not start a model that the catalog lacks, and fails as permanent', async () => {
		const room = open([recorded('plain-answer')], seat({ model: 'gpt-unknown' }));
		const session = room.activate();
		const result = await session.pass(input);
		session.close?.();
		expect(result).toMatchObject({ failed: true, cause: 'permanent' });
		expect(result.failed && result.message).toMatch(/gpt-unknown/);
		expect(room.seen.opened).toEqual([]);
		expect(room.events.some((event) => event.type === 'error')).toBe(true);
	});
});
