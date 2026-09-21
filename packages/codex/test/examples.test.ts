/**
 * The `ts` examples of the package README and of `docs/codex.md` typecheck
 * against the source of the package.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The `ts` fences of a page, in order. */
function examplesOf(path: string): string[] {
	const text = readFileSync(here(path), 'utf8');
	return [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

it('typechecks every ts example of the README and the guide', () => {
	const pages = ['../README.md', '../../../docs/codex.md'];
	const examples = pages.flatMap((page) => examplesOf(page));
	expect(examples.length).toBeGreaterThanOrEqual(2);

	// The examples live in the package, so their imports resolve its dependencies.
	const directory = mkdtempSync(join(here('../'), '.examples-'));
	const files = examples.map((example, index) => {
		const file = join(directory, `example-${index}.ts`);
		writeFileSync(file, example);
		return file;
	});
	const config = join(directory, 'tsconfig.json');
	writeFileSync(
		config,
		JSON.stringify({
			extends: here('../tsconfig.json'),
			compilerOptions: {
				noEmit: true,
				paths: {
					'@ambionframework/codex': [here('../src/index.ts')],
					'@ambionframework/ambion': [here('../../ambion/src/index.ts')],
					'@ambionframework/ambion/hosting': [here('../../ambion/src/hosting.ts')],
					'@ambionframework/journal': [here('../../journal/src/index.ts')],
				},
			},
			include: [],
			files,
		}),
	);
	try {
		execFileSync('pnpm', ['exec', 'tsc', '-p', config], { cwd: here('../'), stdio: 'pipe' });
	} catch (error) {
		const { stdout } = error as { stdout: Buffer };
		throw new Error(`An example does not typecheck:\n${stdout.toString()}`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 120_000);
