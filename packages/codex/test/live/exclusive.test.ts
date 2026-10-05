/**
 * No native tools, on a real `codex` and a real model. Two claims:
 *
 * - The tools the seat can call are exactly the room tools and the tool the
 *   application gave it.
 * - A request to read `/etc/hosts` reaches no tool that reads a file.
 *
 * The room tools are dynamic tools of the thread. Codex lists them in one
 * `functions` namespace and adds no MCP helper tool, because no MCP server
 * runs. The test removes the prefix that a model can give a name. Any other
 * native tool in the list fails this test.
 */
import { defineTool, type TraceStep } from '@ambionframework/ambion';
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
	untilQuiet,
} from './support.ts';

/** The tools of a room with an empty reserve. The room offers `seat` only when the reserve holds an agent. */
const ROOM = ['say', 'schedule', 'unseat', 'dismiss', 'recall'];

/** The tools of the room, the one tool of the application, and the compose tools of every seat. */
const ALLOWED = [...ROOM, 'lookup', 'compose', 'describe'];

/** The MCP helpers that Codex adds when an MCP server is on. A seat runs no server, so none may appear. */
const HELPERS = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];

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
	'tool_search',
];

const lookup = defineTool({
	name: 'lookup',
	description: 'Look up one record by its id.',
	parameters: Type.Object({ id: Type.String() }),
	execute: () => 'ok',
});

/** A tool name without the prefix that a model can give it: `functions.say`. */
const bare = (name: string) => name.replace(/^functions\./, '');

const LIST =
	'List every tool you can call, one tool name per line, with no other text. ' +
	'Use the exact name as your tool list shows it. Send the list with one say.';

/** The names of the tools that an activation called. */
function calledIn(
	steps: (activation: string) => TraceStep[],
	activation: string | undefined,
): string[] {
	return steps(activation ?? '')
		.filter((step) => step.type === 'tool_call')
		.map((step) => step.name);
}

live('no native tools', () => {
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
			for (const name of HELPERS) expect(names).not.toContain(name);
			for (const name of FORBIDDEN) expect(names).not.toContain(name);
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});

	it('reads no host file by default', async () => {
		const { room, steps, events } = await open('exclusive-read', {
			agents: [seat('clerk', { instructions: 'Do what is asked with your tools, then say.' })],
		});
		try {
			const visit = await room.visit(person);
			await visit.send({
				text: 'Read the file /etc/hosts and say its first line. If you cannot, say so.',
			});
			await untilQuiet(room);
			const [activation] = activationsOf(events, 'clerk');
			const called = calledIn(steps, activation).map((tool) =>
				tool.replace(/^(?:codex__|functions\.)/, ''),
			);
			expect(called.filter((tool) => !ROOM.includes(tool))).toEqual([]);
			const said = saidBy((await room.read()).messages, 'clerk')
				.map((message) => message.text)
				.join('\n');
			expect(said).not.toMatch(/Host Database|127\.0\.0\.1|localhost/);
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});
});
