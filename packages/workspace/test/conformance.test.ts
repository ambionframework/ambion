/**
 * The conformance suites. The workspace cases run on the just-bash memory
 * backend, which proves the suite itself; `@ambionframework/just-bash` and
 * `@ambionframework/workstation` run them on their own backends. The object
 * cases run on the default file store over the memory and the directory
 * backends; the S3 tier runs them on MinIO. The SQL cases run in
 * `sqlite.test.ts`.
 */
import { describe, it } from 'vitest';
import { directoryBackend, memoryBackend } from '../../just-bash/src/index.ts';
import { backends, tempDir } from '../../just-bash/test/support/backends.ts';
import type { BashBackend } from '../src/backend.ts';
import {
	type ObjectConformanceBackend,
	objectConformance,
	workspaceConformance,
} from '../src/conformance.ts';
import { fileObjectBackend } from '../src/object-files.ts';
import { openResource } from '../src/resource.ts';

const memory = backends.find((harness) => harness.name === 'memory');
if (memory === undefined) throw new Error('The just-bash harnesses have no memory backend.');

describe.each([memory])('$name', (harness) => {
	for (const c of workspaceConformance(harness)) it(c.name, c.run);
});

/** The default file store at /snapshots over a bash backend under its own owner. */
function fileStore(bash: () => BashBackend) {
	const open = () => {
		const shell = openResource({ name: 'objects', backend: bash() });
		const backend = fileObjectBackend({
			shell: shell.use,
			host: { name: 'objects-host' },
			root: '/snapshots',
		});
		return { backend: { ...backend, dispose: () => shell.dispose() } };
	};
	return open;
}

const objectStores: ObjectConformanceBackend[] = [
	{
		name: 'file store on memory',
		open: async () => {
			const { backend } = fileStore(() => memoryBackend())();
			return { backend, dispose: async () => backend.dispose() };
		},
	},
	{
		name: 'file store on a directory',
		open: async () => {
			const { dir, dispose } = await tempDir('ambion-objects-');
			const open = fileStore(() => directoryBackend(dir));
			const { backend } = open();
			return {
				backend,
				reopen: async () => open().backend,
				dispose: async () => {
					await backend.dispose();
					await dispose();
				},
			};
		},
	},
];

describe.each(objectStores)('$name', (harness) => {
	for (const c of objectConformance(harness)) it(c.name, c.run);
});
