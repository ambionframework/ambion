/**
 * Hands reach a workspace. `docs/workspace.md` §5: an agent that names a
 * workspace holds `read`, `write`, `edit` and `bash`, rooted at its own home.
 * A real provider has to accept those four schemas, and a real model has to
 * pick them up and use them against a filesystem it has never seen.
 */

import { defineWorkspace, destroyWorkspace, stopSession } from '@ambionframework/ambion';
import { expect, it } from 'vitest';
import {
	agent,
	invariants,
	live,
	open,
	person,
	report,
	saidBy,
	spent,
	untilQuiet,
} from '../../../ambion/test/live/support.ts';
import { enter, roomName } from '../../../ambion/test/support/room.ts';
import { memoryBackend } from '../../src/index.ts';

live('the workspace', () => {
	it('a seat reads a file it was told about, writes one back, and answers from what it read', async () => {
		const backend = memoryBackend({
			seed: async ({ writeFile }) => {
				await writeFile(
					'/home/librarian/notes/inventory.txt',
					'crate-19: 7 lanterns\ncrate-20: 3 coils of rope\n',
				);
			},
		});
		const store = defineWorkspace({ name: roomName('live-store'), backend });
		const librarian = agent('librarian', {
			identity: 'Keeps the store notes.',
			instructions: `
				Before you answer a question about a crate, read notes/inventory.txt
				in your home directory with the read tool. Then append one line,
				"checked <crate>", to notes/journal.txt in your home directory. Then
				answer with one say, in one sentence, quoting the count you read.
			`,
			workspace: store,
		});
		const { session, repo, events } = open('workspace', { agents: [librarian] });
		const visit = await enter(session, person);
		await visit.deliver({ text: 'How many lanterns are in crate-19?' });
		await untilQuiet(session);

		const tools = events.flatMap((e) =>
			e.type === 'tool_execution_start' && e.agent === 'librarian' ? [e.toolName] : [],
		);
		expect(tools.some((tool) => tool === 'read' || tool === 'bash')).toBe(true);
		expect(tools.some((tool) => ['write', 'edit', 'bash'].includes(tool))).toBe(true);
		// `say` is the room's own event, never surfaced as a tool.
		expect(tools).not.toContain('say');
		const answer = saidBy(await session.messages(), 'librarian');
		expect(answer).toHaveLength(1);
		expect(answer[0]?.text).toMatch(/\b7\b|seven/i);
		const journal = (await backend.readFiles()).find(
			(f) => f.path === '/home/librarian/notes/journal.txt',
		);
		expect(journal?.text).toMatch(/checked/i);
		await invariants(session, events);
		report('the workspace', await spent(repo, session.name));
		await stopSession(session);
		await destroyWorkspace(store);
	});
});
