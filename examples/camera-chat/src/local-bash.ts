import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	BACKGROUND_CONTEXT,
	type BashBackend,
	resolvePath,
	type WorkspaceEnv,
} from '@ambionframework/workspace';
import { assertAgent } from '@ambionframework/workspace/git';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';

/** A trusted local shell. Agent directories provide organization, without an OS sandbox. */
export function localBashBackend(directory: string): BashBackend {
	const root = resolve(directory);
	let disposed = false;
	return {
		layout: {
			audit: `${root}/audit.jsonl`,
			rooms: `${root}/rooms`,
			snapshots: `${root}/snapshots`,
		},
		gitTransports: ['local-file'],
		guidance:
			'Commands run directly on this Mac as the signed-in user. Your home is an application directory. The shell has full host access and network access. Local Git remotes use filesystem paths. Only use this backend with trusted agents.',
		ports: {
			hostname: 'localhost',
			async open(_agent, port, signal) {
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
			const env = new NodeExecutionEnv({
				cwd: home,
				shellPath: '/bin/bash',
				shellEnv: {
					PATH: process.env.PATH,
					HOME: home,
					LANG: 'en_US.UTF-8',
					GIT_AUTHOR_NAME: agent.name,
					GIT_AUTHOR_EMAIL: `${agent.name}@localhost`,
					GIT_COMMITTER_NAME: agent.name,
					GIT_COMMITTER_EMAIL: `${agent.name}@localhost`,
				},
			});
			return new Proxy(env, {
				get(target, key) {
					if (key === 'cleanup') return () => target.cleanup(BACKGROUND_CONTEXT);
					if (key === 'exec')
						return (
							command: string,
							options: Parameters<WorkspaceEnv['exec']>[1],
							context: Parameters<WorkspaceEnv['exec']>[2],
						) =>
							target.exec(
								command,
								{ ...options, cwd: resolvePath(home, home, options?.cwd ?? home) },
								context,
							);
					const member = Reflect.get(target, key);
					if (typeof member !== 'function') return member;
					return (...args: unknown[]) => {
						if (typeof args[0] === 'string' && key !== 'joinPath')
							args[0] = resolvePath(home, home, args[0]);
						if (key === 'renameFile' && typeof args[1] === 'string')
							args[1] = resolvePath(home, home, args[1]);
						return Reflect.apply(member, target, args);
					};
				},
			}) as unknown as WorkspaceEnv;
		},
		async dispose() {
			disposed = true;
		},
	};
}
