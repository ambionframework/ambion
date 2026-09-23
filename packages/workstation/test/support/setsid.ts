import { spawnSync } from 'node:child_process';

/** Whether this machine has `setsid --wait` from util-linux, which every `exec` needs. */
export const hasSetsid = spawnSync('setsid', ['--wait', 'true']).status === 0;
