/**
 * Tools reach a workspace. `docs/workspace.md`: an agent that names a workspace
 * holds `read`, `write`, `edit`, `bash` and `sql`, rooted at its own home. A
 * real provider has to accept those schemas, and a real model has to pick up
 * the file tools and use them against a filesystem it has never seen. The
 * process tools reach the same home: a model starts two processes and calls
 * `wait` with their handles until both end.
 */

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
import { memoryBackend } from '../../../just-bash/src/index.ts';
import { type AuditEntry, BACKGROUND_CONTEXT, openWorkspace } from '../../src/index.ts';
import { sqliteBackend } from '../../src/sqlite-entry.ts';

/** The entries of the audit log at its default path, oldest first. */
async function auditOf(backend: ReturnType<typeof memoryBackend>): Promise<AuditEntry[]> {
	const log = (await backend.readFiles()).find((file) => file.path === '/workspace/audit.jsonl');
	return (log?.text ?? '')
		.split('\n')
		.filter((line) => line.trim() !== '')
		.map((line) => JSON.parse(line) as AuditEntry);
}

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
		const store = openWorkspace({ name: roomName('live-store'), backend: { bash: backend } });
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
		await store.dispose();
	});

	it('a seat queries the shared database with the sql tool, and answers from the result', async () => {
		const store = openWorkspace({
			name: roomName('live-sql'),
			backend: { bash: memoryBackend(), sql: sqliteBackend(':memory:') },
		});
		// Seed the shared database before the room opens.
		const seeded = await store.sql?.use({ name: 'seed' }, (env) =>
			env.run(
				'CREATE TABLE pour(id INTEGER, grade TEXT, tonnes REAL);' +
					" INSERT INTO pour VALUES (1,'C30',10),(2,'C40',5),(3,'C30',15),(4,'C40',20)",
				{ maxRows: 0 },
				BACKGROUND_CONTEXT,
			),
		);
		if (seeded?.ok !== true) throw new Error('seed failed');
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
		await store.dispose();
	});

	it('a seat starts two processes, waits for them with wait and their handles, and answers from their output', async () => {
		const backend = memoryBackend();
		const store = openWorkspace({
			name: roomName('live-wait'),
			backend: { bash: backend },
			audit: {},
		});
		const runner = agent('runner', {
			identity: 'Runs the two checks.',
			instructions: `
				To answer a question about the checks, start two processes with the
				bash tool and wait 0: "sleep 4; echo alpha-ok" with the name alpha,
				and "sleep 8; echo beta-ok" with the name beta. Then call the wait
				tool with the handles of the processes that still run, until both
				have ended. Then answer with one say, in one sentence, that quotes
				the output of each process.
			`,
			bundles: [store.tools()],
		});
		const { session, events } = await open('workspace', { agents: [runner] });
		const visit = await enter(session, person);
		const exchange = await visit.send({ text: 'Run the two checks and tell me what they print.' });
		await exchange.waitForSummary();

		const waits = (await auditOf(backend)).filter((entry) => entry.tool === 'wait');
		const started = events.filter(
			(e) => e.type === 'tool_execution_start' && e.agent === 'runner' && e.toolName === 'wait',
		);
		process.stdout.write(
			`live · wait: ${started.length} calls started, ${waits.length} reached the tool: ${JSON.stringify(waits.map((entry) => entry.arguments))}\n`,
		);
		// Each call reached the tool with a list of handles, and none failed.
		expect(waits.length).toBeGreaterThanOrEqual(1);
		for (const entry of waits) {
			expect(entry.arguments).toMatchObject({ handles: expect.any(Array) });
			expect(entry.error).toBeUndefined();
		}
		const running = await store.processes.list({ agent: 'runner', running: true });
		expect(running).toEqual([]);
		const answer = saidBy((await session.read()).messages, 'runner');
		const text = answer.map((m) => m.text).join(' ');
		expect(text).toContain('alpha-ok');
		expect(text).toContain('beta-ok');
		await invariants(session, events);
		report('the workspace', await spent(session));
		await session.stop();
		await store.dispose();
	});
});
