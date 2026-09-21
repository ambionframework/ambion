/**
 * Native tools off. The seat reaches the world only through the room tools
 * and the tools the application gives it.
 *
 * Codex 0.155.1 gives a seat native tools that no sandbox setting removes.
 * Code Mode, a JavaScript runtime, reads host files under a read-only
 * sandbox with no network. The model catalog turns it on, so a feature flag
 * cannot turn it off. A custom catalog can. This file holds the recipe:
 *
 * 1. `exclusiveEntry` patches the catalog entry of the model.
 * 2. `exclusiveConfig` turns off every feature and tool the config controls.
 * 3. `Scratch` holds the patched catalog and an empty working directory.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** One model of the catalog that `codex debug models` prints. The executor reads only `slug`. */
export type CatalogEntry = Readonly<Record<string, unknown>> & { readonly slug: string };

/** A fault that a retry cannot clear. The activation fails as permanent. */
export class PermanentError extends Error {}

/** The catalog fields that give a model a native tool, and the value that removes it. */
const NO_NATIVE_TOOLS = {
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
} as const;

/** The entry of a model with no native tool. The input entry stays as it is. */
export function exclusiveEntry(entry: CatalogEntry): CatalogEntry {
	return { ...entry, ...structuredClone(NO_NATIVE_TOOLS) };
}

/** The features of Codex 0.155.1 that give a seat a native tool. Each is off. */
export const EXCLUSIVE_FEATURES: readonly string[] = [
	'shell_tool',
	'apps',
	'browser_use',
	'browser_use_external',
	'browser_use_full_cdp_access',
	'computer_use',
	'image_generation',
	'multi_agent',
	'multi_agent_v2',
	'plugins',
	'goals',
	'hooks',
	'skill_search',
	'sleep_tool',
	'in_app_browser',
	'remote_plugin',
	'plugin_sharing',
	'unified_exec',
	'unified_exec_tty',
	'tool_suggest',
	'request_permissions_tool',
	'default_mode_request_user_input',
	'exec_permission_approvals',
	'view_image',
	'code_mode',
	'code_mode_host',
	'code_mode_only',
	'code_mode_interrupt',
	'code_mode_prewarm',
	'tool_call_mcp_elicitation',
	'skill_mcp_dependency_install',
];

/** The bundled JavaScript REPL server. Codex adds it beside the servers the config names. */
export const NODE_REPL = 'node_repl';

/** The server entry that disables the bundled `node_repl` by name. */
export const NODE_REPL_OFF = { command: 'true', enabled: false } as const;

/** The config keys of the client that turn off the native tools. `mcp_servers` is separate. */
export function exclusiveConfig(catalogPath: string): Record<string, unknown> {
	return {
		model_catalog_json: catalogPath,
		features: Object.fromEntries(EXCLUSIVE_FEATURES.map((name) => [name, false])),
		web_search: 'disabled',
		tools: {
			view_image: false,
			update_plan: { enabled: false },
			experimental_request_user_input: { enabled: false },
		},
	};
}

/** The platform package and the target directory of the `codex` binary, by Node platform and architecture. */
const PLATFORMS: Readonly<Record<string, readonly [string, string]>> = {
	'linux:x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
	'linux:arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
	'android:x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
	'android:arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
	'darwin:x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
	'darwin:arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
	'win32:x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
	'win32:arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
};

/** The binary that the bundled packages hold, or nothing when they are missing. */
function bundledBinary(platform: string, target: string): string | undefined {
	try {
		const sdk = createRequire(import.meta.resolve('@openai/codex-sdk'));
		const codex = createRequire(sdk.resolve('@openai/codex/package.json'));
		const root = join(dirname(codex.resolve(`${platform}/package.json`)), 'vendor', target);
		const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
		return [join(root, 'bin', name), join(root, 'codex', name)].find((path) => existsSync(path));
	} catch {
		return undefined;
	}
}

/**
 * The `codex` binary the SDK runs. `codexPath` wins. Otherwise the lookup
 * follows the SDK: `@openai/codex` resolves from the SDK, and the platform
 * package resolves from `@openai/codex`.
 */
function codexBinary(codexPath?: string): string {
	if (codexPath) return codexPath;
	const key = `${process.platform}:${process.arch}`;
	const platform = PLATFORMS[key];
	if (platform === undefined) {
		throw new PermanentError(`No Codex binary exists for the platform ${key}.`);
	}
	const found = bundledBinary(...platform);
	if (found === undefined) {
		throw new PermanentError(
			'Unable to locate the Codex binary. Install @openai/codex or set codexPath.',
		);
	}
	return found;
}

/** The catalogs that `codex debug models` printed, by binary. A failed run leaves no entry. */
const catalogs = new Map<string, Promise<readonly CatalogEntry[]>>();

/** Run `codex debug models` once for each binary in this process. */
function catalogOf(
	binary: string,
	env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<readonly CatalogEntry[]> {
	const cached = catalogs.get(binary);
	if (cached !== undefined) return cached;
	const pending = run(binary, ['debug', 'models'], {
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, ...env },
	}).then(({ stdout }) => {
		const parsed = JSON.parse(stdout) as { models?: readonly CatalogEntry[] };
		return parsed.models ?? [];
	});
	catalogs.set(binary, pending);
	pending.catch(() => catalogs.delete(binary));
	return pending;
}

/** What answers the catalog entry of a model. The executor takes one so a test can supply the entries. */
export type CatalogSource = (model: string) => Promise<CatalogEntry | undefined>;

/** The catalog entry of `model` from the installed binary, or nothing when the catalog has none. */
export function installedCatalog(
	codexPath: string | undefined,
	env: Readonly<Record<string, string | undefined>> | undefined,
): CatalogSource {
	return async (model) => {
		const models = await catalogOf(codexBinary(codexPath), env);
		return models.find((entry) => entry.slug === model);
	};
}

/** The directories that exist now. The exit hook removes what a seat leaves behind. */
const open = new Set<string>();
let hooked = false;

function removeAll(): void {
	for (const path of open) rmSync(path, { recursive: true, force: true });
	open.clear();
}

/** A patched catalog and an empty working directory, for one activation. */
export class Scratch {
	/** The path of the patched catalog. */
	readonly catalog: string;
	/** An empty directory, so no host file is the default context. */
	readonly directory: string;
	private readonly root: string;

	constructor(entry: CatalogEntry) {
		this.root = mkdtempSync(join(tmpdir(), 'ambion-codex-'));
		open.add(this.root);
		if (!hooked) {
			hooked = true;
			process.once('exit', removeAll);
		}
		this.catalog = join(this.root, 'models.json');
		this.directory = join(this.root, 'work');
		mkdirSync(this.directory);
		writeFileSync(this.catalog, JSON.stringify({ models: [exclusiveEntry(entry)] }));
	}

	/** Remove both. Safe to call again. */
	remove(): void {
		rmSync(this.root, { recursive: true, force: true });
		open.delete(this.root);
	}
}

/** The scratch for `model`. A model with no catalog entry fails as permanent, so native tools never stay on. */
export async function scratchFor(model: string, source: CatalogSource): Promise<Scratch> {
	const entry = await source(model);
	if (entry === undefined) {
		throw new PermanentError(
			`The model '${model}' has no entry in the Codex catalog, and nativeTools 'none' needs one. ` +
				`Set nativeTools: 'codex', or use a model that 'codex debug models' lists.`,
		);
	}
	return new Scratch(entry);
}
