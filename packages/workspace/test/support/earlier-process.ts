/**
 * A process of an earlier run of the host, for the tests of an adopted
 * process. The command runs in a real shell of the workstation's in-process
 * SSH server, and no table of this run owns it.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workstationBackend } from '../../../workstation/src/index.ts';
import type { TestServer } from '../../../workstation/test/support/server.ts';

export const until = async (check: () => boolean, ms = 2_000) => {
	const end = Date.now() + ms;
	while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
};

/**
 * A process that an earlier run of the host started for `agent`: its command
 * runs `onTerm` for each TERM, by default a log line, and goes on. Give its directory and the pid of its wrapper.
 */
export async function earlierProcess(
	started: TestServer,
	agent: string,
	handle: string,
	grace = 10,
	onTerm = 'echo term',
	extra: Readonly<Record<string, unknown>> = {},
) {
	const dir = join(started.homes.get(agent) ?? '', '.processes', handle);
	await mkdir(dir, { recursive: true });
	const spec = { handle, kind: 'bash', agent, command: 'loop', ...extra };
	await writeFile(
		join(dir, 'spec'),
		JSON.stringify({
			...spec,
			timeout: 600,
			grace,
			startedAt: new Date().toISOString(),
		}),
	);
	const earlier = workstationBackend(started.options);
	const env = await earlier.connect({ name: agent });
	const script = [
		'trap : TERM',
		`echo "$$" > '${dir}/pid'`,
		'(',
		`trap '${onTerm}' TERM`,
		'while :; do sleep 0.2; done',
		`) < /dev/null > '${dir}/out' 2>&1`,
		`echo "$? x" > '${dir}/exit'`,
	].join('\n');
	void env.exec(script, { timeout: 60 }).catch(() => undefined);
	await until(() => spawnSync('test', ['-s', join(dir, 'pid')]).status === 0);
	const pid = Number((await readFile(join(dir, 'pid'), 'utf8')).trim());
	await env.cleanup();
	await earlier.dispose?.();
	return { dir, pid };
}
