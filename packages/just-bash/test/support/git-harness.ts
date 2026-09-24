/**
 * The harnesses of the git conformance cases: `justGitBackend` over a
 * temporary SQLite file, beside each just-bash backend. Each `backend` call
 * opens a new git backend over the same file, the way a restart of the host
 * does.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BashBackend } from '@ambionframework/workspace';
import type {
	GitConformanceBackend,
	GitConformanceOptions,
} from '@ambionframework/workspace/conformance';
import { justGitBackend, sqliteGitStorage } from '../../src/git/index.ts';
import { directoryBackend, memoryBackend } from '../../src/index.ts';

export const SECRET = 'conformance-secret';

/** The options of a conformance case, as `justGitBackend` options over `file`. */
export function backendOver(file: string, options: GitConformanceOptions) {
	return justGitBackend({
		storage: sqliteGitStorage(file),
		secret: SECRET,
		...(options.tokenTtl === undefined ? {} : { tokenTtl: options.tokenTtl }),
		templates: Object.fromEntries(
			Object.entries(options.templates).map(([name, template]) => [
				name,
				{
					source: template.files,
					...(template.description === undefined ? {} : { description: template.description }),
				},
			]),
		),
	});
}

function harness(name: string, bash: (dir: string) => BashBackend): GitConformanceBackend {
	return {
		name,
		shortestTokenTtl: 1,
		async open() {
			const dir = await mkdtemp(join(tmpdir(), 'ambion-git-'));
			return {
				bash: bash(join(dir, 'files')),
				backend: (options) => backendOver(join(dir, 'git.db'), options),
				dispose: () => rm(dir, { recursive: true, force: true }),
			};
		},
	};
}

export const harnesses: readonly GitConformanceBackend[] = [
	harness('memory', () => memoryBackend()),
	harness('directory', (dir) => directoryBackend(dir)),
];
