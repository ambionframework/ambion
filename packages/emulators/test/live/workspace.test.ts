/**
 * Tools reach a workspace. `docs/workspace.md`: an agent that names a workspace
 * holds `read`, `write`, `edit`, `bash` and `sql`, rooted at its own home. A
 * real provider has to accept those schemas, and a real model has to pick up
 * the file tools and use them against a filesystem it has never seen.
 */

import { BACKGROUND_CONTEXT, openWorkspace } from '@ambionframework/workspace';
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
		const store = openWorkspace({ name: roomName('live-store'), backend });
		const librarian = agent('librarian', {
			identity: 'Keeps the store notes.',
			instructions: `
				Before you answer a question about a crate, read notes/inventory.txt
				in your home directory with the read tool. Then append one line,
				"checked <crate>", to notes/journal.txt in your home directory. Then
				answer with one say, in one sentence, quoting the count you read.
			`,
			bundles: [store.tools()],
		});
		const { session, events } = await open('workspace', { agents: [librarian] });
		const visit = await enter(session, person);
		const exchange = await visit.send({ text: 'How many lanterns are in crate-19?' });
		await exchange.waitForSummary();

		const tools = events.flatMap((e) =>
			e.type === 'tool_execution_start' && e.agent === 'librarian' ? [e.toolName] : [],
		);
		expect(tools.some((tool) => tool === 'read' || tool === 'bash')).toBe(true);
		expect(tools.some((tool) => ['write', 'edit', 'bash'].includes(tool))).toBe(true);
		// `say` is the room's own event, never surfaced as a tool.
		expect(tools).not.toContain('say');
		const answer = saidBy((await session.read()).messages, 'librarian');
		expect(answer).toHaveLength(1);
		expect(answer[0]?.text).toMatch(/\b7\b|seven/i);
		const journal = (await backend.readFiles()).find(
			(f) => f.path === '/home/librarian/notes/journal.txt',
		);
		expect(journal?.text).toMatch(/checked/i);
		await invariants(session, events);
		report('the workspace', await spent(session));
		await session.stop();
		await store.destroy();
	});

	it('a seat queries the shared database with the sql tool, and answers from the result', async () => {
		const backend = memoryBackend();
		const store = openWorkspace({ name: roomName('live-sql'), backend });
		// Seed the shared database before the room opens.
		await store.use({ name: 'seed', identity: 'Seeds the database.' }, async (env) => {
			const result = await env.exec(
				'sqlite3 /workspace/shared.db "CREATE TABLE pour(id INTEGER, grade TEXT, tonnes REAL);' +
					" INSERT INTO pour VALUES (1,'C30',10),(2,'C40',5),(3,'C30',15),(4,'C40',20)\"",
				undefined,
				BACKGROUND_CONTEXT,
			);
			if (!result.ok || result.value.exitCode !== 0) throw new Error('seed failed');
		});
		const analyst = agent('analyst', {
			identity: 'Reads the pour data.',
			instructions: `
				You have a sql tool over a shared SQLite database. A table
				pour(id, grade, tonnes) already holds the data. Before you answer a
				question about pours, run one query with the sql tool. Then answer
				with one say, in one sentence, that quotes the total.
			`,
			bundles: [store.tools()],
		});
		const { session, events } = await open('workspace', { agents: [analyst] });
		const visit = await enter(session, person);
		const exchange = await visit.send({ text: 'What is the total tonnes for grade C30?' });
		await exchange.waitForSummary();

		const tools = events.flatMap((e) =>
			e.type === 'tool_execution_start' && e.agent === 'analyst' ? [e.toolName] : [],
		);
		expect(tools).toContain('sql');
		const answer = saidBy((await session.read()).messages, 'analyst');
		expect(answer.length).toBeGreaterThanOrEqual(1);
		expect(answer.map((m) => m.text).join(' ')).toMatch(/\b25\b/);
		await invariants(session, events);
		report('the workspace', await spent(session));
		await session.stop();
		await store.destroy();
	});
});
