import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BashBackend, GitBackend } from '@ambionframework/workspace';
import { assertAgent } from '@ambionframework/workspace/git';
import { LocalEnv } from './local-env.ts';

/** A trusted local shell. Agent directories provide organization, without an OS sandbox. */
export function localBashBackend(directory: string, git: GitBackend): BashBackend {
	const root = resolve(directory);
	let disposed = false;
	return {
		layout: {
			audit: `${root}/audit.jsonl`,
			rooms: `${root}/rooms`,
			snapshots: `${root}/snapshots`,
		},
		git,
		guidance:
			'Commands run directly on this Mac as the signed-in user. Your home is an application directory. The shell has full host access and network access. Local Git remotes use filesystem paths. Only use this backend with trusted agents.',
		endpoints: {
			machine: 'localhost',
			async forward(_agent, port, signal) {
				signal?.throwIfAborted();
				if (disposed) throw new Error('The local backend is disposed.');
				if (!Number.isInteger(port) || port < 1 || port > 65535)
					throw new Error('Invalid local port.');
				return { url: `http://127.0.0.1:${port}`, close: async () => {} };
			},
		},
		async connect(agent, signal) {
			signal?.throwIfAborted();
			if (disposed) throw new Error('The local backend is disposed.');
			assertAgent(agent);
			const home = `${root}/homes/${agent.name}`;
			await mkdir(home, { recursive: true });
			// The shell gets only these variables. The host environment stays out of it.
			return new LocalEnv(home, {
				PATH: process.env.PATH ?? '/usr/bin:/bin',
				HOME: home,
				LANG: 'en_US.UTF-8',
				GIT_AUTHOR_NAME: agent.name,
				GIT_AUTHOR_EMAIL: `${agent.name}@localhost`,
				GIT_COMMITTER_NAME: agent.name,
				GIT_COMMITTER_EMAIL: `${agent.name}@localhost`,
			});
		},
		async dispose() {
			disposed = true;
		},
	};
}
