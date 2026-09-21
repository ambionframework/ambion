/** What the package exports, and what it leaves out of the other packages. */
import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import * as entry from '../src/index.ts';

type Manifest = Record<string, Record<string, string> | undefined>;

const manifestOf = (path: string): Manifest =>
	JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

it('exports the executor, its execution and nothing else', () => {
	expect(Object.keys(entry).sort()).toEqual(['codex', 'codexExecution', 'createCodexExecutor']);
});

it('pins the two SDKs to exact versions', () => {
	const dependencies = manifestOf('../package.json').dependencies ?? {};
	expect(dependencies['@openai/codex-sdk']).toMatch(/^\d+\.\d+\.\d+$/);
	expect(dependencies['@modelcontextprotocol/sdk']).toMatch(/^\d+\.\d+\.\d+$/);
});

it('leaves the Codex SDK and the MCP SDK out of the kernel and the other packages', () => {
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
			expect(names, `${dir} ${field}`).not.toContain('@openai/codex-sdk');
			expect(names, `${dir} ${field}`).not.toContain('@modelcontextprotocol/sdk');
		}
	}
});
