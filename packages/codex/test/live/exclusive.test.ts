/**
 * Native tools off, on a real `codex` and a real model. Three claims:
 *
 * - With the default `nativeTools: 'none'`, the tools the seat can call are
 *   exactly the room tools and the tool the application gave it.
 * - With the default, a request to read `/etc/hosts` reaches no tool that
 *   reads a file.
 * - With `nativeTools: 'codex'`, the native tools return.
 *
 * Codex adds a server prefix to the name of an MCP tool. The test removes
 * it. If a Codex upgrade shows `list_mcp_resources` and `read_mcp_resource`
 * because an MCP server exists, the first claim may allow exactly those two.
 * Today it allows neither. Any other native tool in the list fails the test.
 */
import { defineTool } from '@ambionframework/ambion';
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import {
	activationsOf,
	errorsIn,
	live,
	open,
	person,
	saidBy,
	seat,
	stepsOf,
	untilQuiet,
} from './support.ts';

/** The tools of the room. */
const ROOM = ['say', 'seat', 'unseat'];

/** The tools of the room and the one tool of the application. */
const ALLOWED = [...ROOM, 'lookup'];

/** Native tools that no exclusive seat may hold. */
const FORBIDDEN = [
	'exec',
	'wait',
	'shell',
	'exec_command',
	'write_stdin',
	'apply_patch',
	'web_search',
	'web.run',
	'view_image',
	'node_repl',
	'request_user_input',
	'spawn_agent',
	'list_mcp_resources',
	'read_mcp_resource',
	'tool_search',
];

const lookup = defineTool({
	name: 'lookup',
	description: 'Look up one record by its id.',
	parameters: Type.Object({ id: Type.String() }),
	execute: () => 'ok',
});

/** A tool name without the prefix that Codex adds: `mcp__ambion__say`, `ambion.say`. */
const bare = (name: string) => name.replace(/^.*(?:__|\.)(?=[^_.]+$)/, '');

const LIST =
	'List every tool you can call, one tool name per line, with no other text. ' +
	'Use the exact name as your tool list shows it. Send the list with one say.';

/** The names of the tools that an activation called. */
async function calledIn(
	name: string,
	activation: string | undefined,
	runtime: Awaited<ReturnType<typeof open>>['runtime'],
): Promise<string[]> {
	const steps = await stepsOf(name, activation ?? '', runtime);
	return steps.filter((step) => step.type === 'tool_call').map((step) => step.name);
}

live('nativeTools', () => {
	it('gives the seat exactly the room tools and its own tools by default', async () => {
		const { room, events } = await open('exclusive-list', {
			agents: [seat('clerk', { tools: [lookup], instructions: 'Answer with one say.' })],
		});
		try {
			const visit = await room.visit(person);
			await visit.send({ text: LIST });
			await untilQuiet(room);
			const messages = (await room.read()).messages;
			const text = saidBy(messages, 'clerk')
				.map((message) => message.text)
				.join('\n');
			const names = [
				...new Set(
					text
						.split('\n')
						.map((line) => bare(line.replace(/[`*\-\s]/g, '')))
						.filter((line) => line !== ''),
				),
			].sort();
			expect(names).toEqual([...ALLOWED].sort());
			for (const name of FORBIDDEN) expect(names).not.toContain(name);
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});

	it('reads no host file by default', async () => {
		const { room, name, runtime, events } = await open('exclusive-read', {
			agents: [seat('clerk', { instructions: 'Do what is asked with your tools, then say.' })],
		});
		try {
			const visit = await room.visit(person);
			await visit.send({
				text: 'Read the file /etc/hosts and say its first line. If you cannot, say so.',
			});
			await untilQuiet(room);
			const [activation] = activationsOf(events, 'clerk');
			const called = await calledIn(name, activation, runtime);
			expect(called.filter((tool) => !ROOM.includes(tool))).toEqual([]);
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});

	it('brings the native tools back with nativeTools codex', async () => {
		const { room, name, runtime, events } = await open('exclusive-codex', {
			agents: [
				seat('clerk', {
					nativeTools: 'codex',
					instructions: 'Do what is asked with your own tools, then say.',
				}),
			],
		});
		try {
			const visit = await room.visit(person);
			await visit.send({ text: 'Run the shell command `echo ambion` and say what it printed.' });
			await untilQuiet(room);
			const [activation] = activationsOf(events, 'clerk');
			const called = await calledIn(name, activation, runtime);
			expect(called.some((tool) => !ROOM.includes(tool))).toBe(true);
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});
});
