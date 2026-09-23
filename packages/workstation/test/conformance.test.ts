/**
 * The scripted tier runs the workspace conformance cases on a workstation
 * over the in-process SSH server. It needs `setsid --wait` from util-linux,
 * so it skips on a machine without it, such as macOS.
 */

import {
	type ConformanceBackend,
	workspaceConformance,
} from '@ambionframework/workspace/conformance';
import { describe, it } from 'vitest';
import { workstationBackend } from '../src/index.ts';
import { startSshServer } from './support/server.ts';
import { hasSetsid } from './support/setsid.ts';

const harness: ConformanceBackend = {
	name: 'workstation',
	async open() {
		const server = await startSshServer(['conformance']);
		const backend = workstationBackend(server.options);
		return {
			backend,
			dispose: async () => {
				await backend.dispose?.();
				await server.stop();
			},
		};
	},
};

describe.skipIf(!hasSetsid)(harness.name, () => {
	for (const c of workspaceConformance(harness)) it(c.name, c.run);
});
