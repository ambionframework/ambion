/**
 * The harnesses of the git conformance cases: `justGitBackend` over a
 * temporary SQLite file, beside each just-bash backend. Each `backend` call
 * opens a new git backend over the same file, the way a restart of the host
 * does. The hooks answer the credential facts for the `in-process`
 * transport: they call `credentialFor` of the access, and the expiry probe
 * sends the token to the server in the process.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BashBackend } from '@ambionframework/workspace';
import type {
	GitConformanceBackend,
	GitConformanceOptions,
	GitConformancePair,
	GitConformanceProbe,
} from '@ambionframework/workspace/conformance';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { type JustGitBackend, justGitBackend, sqliteGitStorage } from '../../src/git/index.ts';
import { directoryBackend, memoryBackend } from '../../src/index.ts';

export const SECRET = 'conformance-secret';

/** The options of a conformance case, as `justGitBackend` options over `file`. */
export function backendOver(file: string, options: GitConformanceOptions) {
	return justGitBackend({
		storage: sqliteGitStorage(file),
		secret: SECRET,
		...(options.credentialTtl === undefined ? {} : { tokenTtl: options.credentialTtl }),
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

type Pair = GitConformancePair<JustGitBackend>;

/** The credential of `agent` for the repository `id`, as the `git` of its shell asks for it. */
const credentialOf = ({ backend }: Pair, agent: WorkspaceAgent, id: string) =>
	backend.access.credentialFor(agent, `${backend.access.prefix}${id}`);

/** A read credential for `templates/blank`, sent to the server as a bearer token. */
async function probeCredential(pair: Pair, agent: WorkspaceAgent): Promise<GitConformanceProbe> {
	const credential = await credentialOf(pair, agent, 'templates/blank');
	if (credential?.scope !== 'read') throw new Error('The agent holds no read credential.');
	const { fetch } = pair.backend.access;
	return {
		expiresAt: credential.expiresAt,
		accepted: async () => {
			const { status } = await fetch(`${credential.url}/info/refs?service=git-upload-pack`, {
				headers: { Authorization: `Bearer ${credential.token}` },
			});
			if (status !== 200 && status !== 401) throw new Error(`The server answered ${status}.`);
			return status === 200;
		},
	};
}

function harness(
	name: string,
	bash: (dir: string) => BashBackend,
): GitConformanceBackend<JustGitBackend> {
	return {
		name,
		shortestCredentialTtl: 1,
		sourcesCredential: async (pair, agent) =>
			(await credentialOf(pair, agent, 'template-sources/blank')) !== undefined,
		issueCredentials: async (pair, agent) => {
			await credentialOf(pair, agent, 'templates/blank');
		},
		writeCredential: async ({ backend }, agent, url) =>
			(await backend.access.credentialFor(agent, url))?.scope === 'write',
		probeCredential,
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

export const harnesses: readonly GitConformanceBackend<JustGitBackend>[] = [
	harness('memory', () => memoryBackend()),
	harness('directory', (dir) => directoryBackend(dir)),
];
