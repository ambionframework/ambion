import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byAgent, quiet, scripted, speak } from '@ambionframework/pi/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { hostClient } from '../src/lib/host-client.ts';
import { openHost } from '../templates/node/src/host.ts';

// A cold runner loads the Pi modules and opens two SQLite journals in this test.
// The default 5 second limit is too tight there, so the test states its own limits.
const RESTART_TEST_MS = 30_000;
const CLOSE_POLL_MS = 15_000;

const stream = scripted(
	byAgent({
		planner: (_context, _agent, call) => (call === 1 ? speak('Start with the data.') : quiet()),
	}),
);

describe('the node template host', () => {
	const directories: string[] = [];

	afterEach(async () => {
		for (const directory of directories.splice(0))
			await rm(directory, { recursive: true, force: true });
	});

	it(
		'resumes the room and its question after a restart',
		async () => {
			const directory = await mkdtemp(join(tmpdir(), 'ambion-node-template-'));
			directories.push(directory);
			const first = await openHost({ directory, stream });
			let questionAt: number;
			try {
				await first.join();
				const sent = await first.send('What should we decide first?');
				questionAt = sent.from;
				await expect
					.poll(
						async () => {
							const exchange = (await first.read()).exchanges.find(
								(item) => item.from === sent.from,
							);
							return exchange?.status;
						},
						{ timeout: CLOSE_POLL_MS },
					)
					.toBe('closed');
			} finally {
				await first.close();
			}
			const second = await openHost({ directory, stream });
			try {
				const read = await second.read();
				expect(read.initialized).toBe(true);
				expect(read.messages.map((message) => message.kind === 'said' && message.text)).toContain(
					'What should we decide first?',
				);
				expect(read.exchanges.some((exchange) => exchange.from === questionAt)).toBe(true);
				const after = await second.read({ since: read.messages.at(-1)?.seq ?? 0 });
				expect(after.messages).toEqual([]);
			} finally {
				await second.close();
			}
		},
		RESTART_TEST_MS,
	);

	it('serves the terminal through the room client', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ambion-node-template-'));
		directories.push(directory);
		const client = hostClient(await openHost({ directory, stream }));
		try {
			await expect(client.health()).resolves.toEqual({ ok: true });
			const started = await client.start();
			expect(started.started).toBe('team');
			const joined = await client.join();
			expect(joined.participants.map((participant) => participant.name)).toContain('human');
			const sent = await client.send('Hello team');
			expect(sent.owner).toBe('human');
			expect((await client.read({ since: 0 })).messages.length).toBeGreaterThan(0);
		} finally {
			await client.close();
		}
	});
});
