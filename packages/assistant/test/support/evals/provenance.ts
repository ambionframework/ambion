import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Preserve the evaluated source when a local run includes uncommitted files. */
export async function retainSources(directory: string): Promise<string> {
	const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
	const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
	const sources: Record<string, string> = {};
	for (const folder of [
		'packages/ambion/src',
		'packages/evals/src',
		'packages/assistant/src',
		'packages/assistant/test/support/evals',
		'packages/assistant/test/live',
	]) {
		for (const path of await sourceFiles(join(root, folder)))
			sources[relative(root, path)] = await readFile(path, 'utf8');
	}
	for (const folder of ['packages/evals/dist', 'packages/ambion/dist']) {
		for (const path of await sourceFiles(join(root, folder), '.mjs'))
			sources[relative(root, path)] = await readFile(path, 'utf8');
	}
	sources['pnpm-lock.yaml'] = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');
	const digest = createHash('sha256').update(JSON.stringify(sources)).digest('hex');
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, 'sources.json'),
		JSON.stringify({ revision, digest, sources }, null, 2),
	);
	return `${revision}+suite:${digest}`;
}

async function sourceFiles(directory: string, extension = '.ts'): Promise<string[]> {
	const files: string[] = [];
	for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(path, extension)));
		else if (entry.name.endsWith(extension)) files.push(path);
	}
	return files;
}
