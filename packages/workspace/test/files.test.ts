/**
 * `WorkspaceFiles`: the chunks land in a temporary file beside the target,
 * and the target changes only after the last chunk.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { workspaceFiles } from '../src/files.ts';
import { memoryBackend } from '../src/just-bash.ts';
import { openResource } from '../src/resource.ts';

const agent = { name: 'alpha' };

function open() {
	const backend = memoryBackend();
	const resource = openResource({ name: 'files', backend });
	return { backend, files: workspaceFiles(resource.use, agent) };
}

describe('WorkspaceFiles', () => {
	it('writes the chunks through a temporary file beside the target', async () => {
		const { backend, files } = open();
		const seen: string[] = [];
		async function* chunks() {
			yield 'a,';
			const during = await backend.readFiles();
			seen.push(...during.map((file) => file.path));
			yield 'b\n';
		}
		const target = await files.writeFile('out/rows.csv', chunks(), BACKGROUND_CONTEXT);
		expect(target).toBe('/home/alpha/out/rows.csv');
		const part = seen.find((path) => path.endsWith('.part'));
		expect(part?.startsWith('/home/alpha/out/rows.csv.')).toBe(true);
		expect(seen).not.toContain(target);
		const after = await backend.readFiles();
		expect(after.filter((file) => file.path.endsWith('.part'))).toEqual([]);
		expect(after.find((file) => file.path === target)?.text).toBe('a,b\n');
	});

	it('writes an empty target when no chunk arrives', async () => {
		const { backend, files } = open();
		const target = await files.writeFile('empty.csv', [], BACKGROUND_CONTEXT);
		const after = await backend.readFiles();
		expect(after.find((file) => file.path === target)?.text).toBe('');
		expect(after.filter((file) => file.path.endsWith('.part'))).toEqual([]);
	});

	it('removes the temporary file and keeps the target when a chunk fails', async () => {
		const { backend, files } = open();
		await files.writeFile('kept.csv', ['old'], BACKGROUND_CONTEXT);
		async function* failing() {
			yield 'new';
			throw new Error('the query stopped');
		}
		await expect(files.writeFile('kept.csv', failing(), BACKGROUND_CONTEXT)).rejects.toThrow(
			'the query stopped',
		);
		const after = await backend.readFiles();
		expect(after.filter((file) => file.path.endsWith('.part'))).toEqual([]);
		expect(after.find((file) => file.path === '/home/alpha/kept.csv')?.text).toBe('old');
	});
});
