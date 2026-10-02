/** What the package exports, and what it leaves out of the other packages. */
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as entry from '../src/index.ts';

type Manifest = Record<string, Record<string, string> | undefined>;

const manifestOf = (path: string): Manifest =>
	JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

it('exports the executor, its execution and nothing else, and pins the Codex binary to an exact version', () => {
	expect(Object.keys(entry).sort()).toEqual(['codex', 'codexExecution']);
	const dependencies = manifestOf('../package.json').dependencies ?? {};
	expect(dependencies['@openai/codex']).toMatch(/^\d+\.\d+\.\d+$/);
	// The room tools are dynamic tools of the thread, so no MCP library and no SDK belong here.
	expect(dependencies).not.toHaveProperty('@modelcontextprotocol/sdk');
	expect(dependencies).not.toHaveProperty('@openai/codex-sdk');
});

it('leaves the Codex binary package out of the kernel and the other packages', () => {
	const others = readdirSync(new URL('../../', import.meta.url)).filter((dir) => dir !== 'codex');
	for (const dir of others) {
		let manifest: Manifest;
		try {
			manifest = manifestOf(`../../${dir}/package.json`);
		} catch {
			continue;
		}
		for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
			const names = Object.keys(manifest[field] ?? {});
			expect(names, `${dir} ${field}`).not.toContain('@openai/codex');
			expect(names, `${dir} ${field}`).not.toContain('@openai/codex-sdk');
		}
	}
});
