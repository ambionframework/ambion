/** A scripted room makes one shared push visible to a second seat. */

import { describe, expect, it, onTestFinished } from 'vitest';
import { callTool, quiet } from '../../ambion/test/support/scripted.ts';
import { justGitBackend, sqliteGitStorage } from '../../just-bash/src/git/index.ts';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { BACKGROUND_CONTEXT, openWorkspace } from '../src/index.ts';
import { agent, run } from './support/room.ts';

describe('shared git in a room', () => {
	it('lets one seat push and another seat clone and read the shared commit', async () => {
		const workspace = openWorkspace({
			name: 'shared-room',
			backend: {
				bash: memoryBackend({
					git: justGitBackend({
						storage: sqliteGitStorage(':memory:'),
						secret: 'shared-room-secret',
						shared: { notes: { source: { 'README.md': 'room notes\n' } } },
					}),
				}),
			},
		});
		onTestFinished(() => workspace.dispose());
		const repo = await workspace.git?.use({ name: 'analyst' }, (env) => env.get('shared/notes'));
		if (repo === undefined) throw new Error('The room shared repository was not registered.');
		const writerPushed = Promise.withResolvers<void>();
		const reviewerPushed = Promise.withResolvers<void>();
		const room = await run(
			[
				agent('analyst', { bundles: [workspace.tools()] }),
				agent('reviewer', { bundles: [workspace.tools()] }),
			],
			{
				analyst: async (_context, _who, request) => {
					if (request === 1)
						return callTool('bash', {
							command: `git clone ${repo.url} ~/notes && cd ~/notes && echo analyst > contribution.txt && git add contribution.txt && git commit -m analyst && git push origin main`,
							wait: 15,
							timeout: 30,
						});
					if (request === 2) {
						writerPushed.resolve();
						await reviewerPushed.promise;
						return callTool('bash', {
							command: 'cd ~/notes && git pull --rebase origin main && cat reviewer.txt',
							wait: 15,
							timeout: 30,
						});
					}
					return quiet();
				},
				reviewer: async (_context, _who, request) => {
					if (request === 1) {
						await writerPushed.promise;
						return callTool('bash', {
							command: `git clone ${repo.url} ~/peer && cat ~/peer/contribution.txt && echo reviewer > ~/peer/reviewer.txt && cd ~/peer && git add reviewer.txt && git commit -m reviewer && git push origin main`,
							wait: 15,
							timeout: 30,
						});
					}
					if (request === 2) reviewerPushed.resolve();
					return quiet();
				},
			},
		);
		expect(room).toBeDefined();
		const read = await workspace.use({ name: 'reviewer' }, (env) =>
			env.readTextFile('~/peer/contribution.txt', BACKGROUND_CONTEXT),
		);
		expect(read.ok && read.value).toBe('analyst\n');
		const reviewerRead = await workspace.use({ name: 'analyst' }, (env) =>
			env.readTextFile('~/notes/reviewer.txt', BACKGROUND_CONTEXT),
		);
		expect(reviewerRead.ok && reviewerRead.value).toBe('reviewer\n');
	});
});
