/**
 * One tool set and one filesystem on the real families. Three claims:
 *
 * - Each seat, the assistant included, lists the same tool names, and none of them is a native tool.
 * - One specialist writes a file with the workspace tool, and the others read it back.
 * - A request to read `/etc/hosts` reaches no tool that reads a host file.
 *
 * A family without its key skips its part. The Claude harness prefixes each
 * tool name with `mcp__ambion__`. The Codex harness adds its own prefix.
 * The test removes both. Codex adds three MCP helper tools whenever an MCP
 * server is on. They reach no resource here, and the test ignores them.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createRuntime,
	isSpoken,
	type Message,
	type Room,
	type RoomNotification,
	readActivation,
	startRoom,
} from '@ambionframework/ambion';
import { composeExecutions } from '@ambionframework/ambion/hosting';
import { settled } from '@ambionframework/ambion/testing';
import { claudeExecution } from '@ambionframework/claude';
import { codexExecution } from '@ambionframework/codex';
import { memoryJournals } from '@ambionframework/journal';
import { piExecution } from '@ambionframework/pi';
import { openWorkspace } from '@ambionframework/workspace';
import { memoryBackend } from '@ambionframework/workspace/just-bash';
import { openSqlResource } from '@ambionframework/workspace/sql';
import { describe, expect, it } from 'vitest';
import { people, team } from '../../src/definitions.ts';
import { type Family, hasKey, seatFamilies } from '../../src/families.ts';
import { openInstrument } from '../../src/instrument.ts';
import { instruments, labSchema, labWritable } from '../../src/scenarios.ts';

const QUIET_MS = 150_000;

/** The assistant and the specialists, each with the family it runs on. */
const specialists = ['assistant', 'datasheets', 'design', 'experiments'] as const;

/** Native tool names of the three harnesses. No seat holds one. */
const NATIVE = [
	'exec',
	'wait',
	'shell',
	'Bash',
	'Read',
	'Write',
	'Edit',
	'Glob',
	'Grep',
	'apply_patch',
	'web_search',
	'web.run',
	'view_image',
	'node_repl',
	'request_user_input',
];

/** The MCP helpers that Codex adds when an MCP server is on. */
const HELPERS = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];

/** The tools that read or run a host file, by any prefix. */
const HOST_READERS = [...NATIVE, 'exec_command', 'write_stdin', 'Task', 'WebFetch'];

/** A tool name without the prefix of a harness. */
const bare = (name: string) =>
	name.replace(/^(?:functions\.|mcp__ambion__|mcp__ambion\.|ambion\.|codex__)/, '');

const LIST =
	'List every tool you can call, one tool name per line, with no other text. ' +
	'Use the exact name as your tool list shows it. Send the list with one say.';

const familyOf = (name: string): Family => seatFamilies[name] ?? 'pi';

function asker() {
	const [person] = people;
	if (!person) throw new Error('The Workbench has no person.');
	return person;
}

async function openRoom(seats: readonly string[]) {
	const directory = await mkdtemp(join(tmpdir(), 'ambion-workbench-toolset-live-'));
	const workspace = openWorkspace({ name: 'workbench', backend: { bash: memoryBackend() } });
	const lab = openSqlResource({
		name: 'lab',
		location: join(directory, 'lab.db'),
		schema: labSchema,
		writable: labWritable,
	});
	const built = team(workspace, lab, openInstrument({ lab, instruments }));
	const runtime = createRuntime({
		storage: memoryJournals(),
		execution: composeExecutions({
			pi: piExecution({}),
			claude: claudeExecution({}),
			codex: codexExecution({}),
		}),
	});
	const name = `toolset-live-${process.pid}-${Date.now()}`;
	const room = await startRoom({
		name,
		goal: 'Report on the tools you hold.',
		agents: built.agents.filter((agent) => seats.includes(agent.name)),
		runtime,
		seats: Object.fromEntries(seats.map((seat) => [seat, 'named' as const])),
	});
	const events: RoomNotification[] = [];
	room.subscribe((event) => void events.push(event));
	const close = async () => {
		await room.stop().catch(() => undefined);
		await workspace.dispose().catch(() => undefined);
		await lab.dispose().catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	};
	return { room, name, runtime, events, close };
}

async function untilQuiet(room: Room): Promise<void> {
	try {
		await settled(room, { timeout: QUIET_MS });
	} catch (error) {
		await room.abort().catch(() => undefined);
		throw error;
	}
}

/** Ask one seat and wait for the room to go quiet. Returns what the seat said. */
async function ask(room: Room, seat: string, text: string): Promise<string> {
	const before = (await room.read()).messages.length;
	await (await room.visit(asker())).send({ to: seat, text });
	await untilQuiet(room);
	const messages: readonly Message[] = (await room.read()).messages.slice(before);
	return messages
		.filter(isSpoken)
		.filter((message) => message.from === seat)
		.map((message) => message.text)
		.join('\n');
}

/** The names of the tools that one seat called, from the trace of its activations. */
async function calledBy(
	opened: Awaited<ReturnType<typeof openRoom>>,
	seat: string,
): Promise<string[]> {
	const activations = opened.events.flatMap((event) =>
		event.type === 'activation_start' && event.agent === seat ? [event.activation] : [],
	);
	const reads = await Promise.all(
		activations.map((id) => readActivation(opened.name, id, { runtime: opened.runtime })),
	);
	return reads
		.flatMap((read) => read?.passes.flatMap((pass) => [...pass.steps]) ?? [])
		.flatMap((step) => (step.type === 'tool_call' ? [bare(step.name)] : []));
}

const namesIn = (text: string): string[] =>
	[
		...new Set(
			text
				.split('\n')
				.map((line) => bare(line.replace(/[`*\-\s]/g, '')))
				.filter((line) => line !== '' && !HELPERS.includes(line)),
		),
	].sort();

/** The specialists whose family has a key. A family with no key skips its part. */
const available = specialists.filter((seat) => hasKey(familyOf(seat)));

describe.skipIf(available.length === 0)('Workbench tool set on every family', () => {
	it('lists the same tools for every seat, and no native tool', async () => {
		const opened = await openRoom(available);
		try {
			const lists = new Map<string, string[]>();
			for (const seat of available) lists.set(seat, namesIn(await ask(opened.room, seat, LIST)));
			const [first, ...rest] = available.map((seat) => lists.get(seat) ?? []);
			expect(first?.length).toBeGreaterThan(0);
			for (const list of rest) expect(list).toEqual(first);
			for (const list of lists.values())
				for (const name of NATIVE) expect(list).not.toContain(name);
		} finally {
			await opened.close();
		}
	});

	it.skipIf(available.length < 2)(
		'shares one filesystem: one specialist writes a file and the others read it back',
		async () => {
			const opened = await openRoom(available);
			try {
				const token = `ambion-${Date.now().toString(36)}`;
				const path = `/shared/live-${token}.md`;
				const [writer = '', ...readers] = available;
				await ask(
					opened.room,
					writer,
					`Write the text ${token} to the file ${path} with your write tool. Then say done.`,
				);
				for (const seat of readers) {
					const said = await ask(
						opened.room,
						seat,
						`Read the file ${path} with your read tool and say its exact content.`,
					);
					expect(said, seat).toContain(token);
				}
			} finally {
				await opened.close();
			}
		},
	);

	it('reads no host file when asked for /etc/hosts', async () => {
		const opened = await openRoom(available);
		try {
			for (const seat of available) {
				await ask(
					opened.room,
					seat,
					'Read the file /etc/hosts and say its first line. If you cannot, say so.',
				);
				const called = (await calledBy(opened, seat)).filter((tool) => !HELPERS.includes(tool));
				for (const tool of HOST_READERS) expect(called, seat).not.toContain(tool);
			}
			const errors = opened.events.filter(
				(event) => event.type === 'error' || event.type === 'delivery_error',
			);
			expect(errors).toEqual([]);
		} finally {
			await opened.close();
		}
	});
});
