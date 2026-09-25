/**
 * `WorkspaceFiles`: the chunks land in a temporary file beside the target,
 * and the target changes only after the last chunk. A read follows a
 * symbolic link, checks the size first, and names each refusal.
 */

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { workspaceFiles } from '../src/files.ts';
import { openResource } from '../src/resource.ts';

const agent = { name: 'alpha' };

function open() {
	const backend = memoryBackend();
	const resource = openResource({ name: 'files', backend });
	return { backend, resource, files: workspaceFiles(resource.use, agent) };
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

	it('reads a file of at most maxBytes, follows a symbolic link, and names every refusal', async () => {
		const { resource, files } = open();
		await files.writeFile('in/rows.csv', ['a,b\n1,2\n'], BACKGROUND_CONTEXT);
		await resource.use(agent, (env) =>
			env.exec('ln -s /home/alpha/in/rows.csv /home/alpha/link.csv', undefined, BACKGROUND_CONTEXT),
		);
		const text = 'a,b\n1,2\n';
		expect(await files.readFile('in/rows.csv', 8, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			path: '/home/alpha/in/rows.csv',
			text,
		});
		expect(await files.readFile('~/link.csv', 8, BACKGROUND_CONTEXT)).toEqual({
			ok: true,
			path: '/home/alpha/link.csv',
			text,
		});
		const refusals: [string, number, string][] = [
			[
				'in/rows.csv',
				7,
				'/home/alpha/in/rows.csv holds 8 bytes, and an import reads at most 7 bytes.',
			],
			['in', 8, '/home/alpha/in is not a file.'],
			['missing.csv', 8, 'Cannot read /home/alpha/missing.csv: '],
		];
		for (const [path, maxBytes, message] of refusals) {
			const read = await files.readFile(path, maxBytes, BACKGROUND_CONTEXT);
			expect(read.ok ? '' : read.message, path).toContain(message);
		}
		const controller = new AbortController();
		controller.abort(new Error('cut'));
		const aborted = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
		await expect(files.readFile('in/rows.csv', 8, aborted)).rejects.toThrow();
	});
});
