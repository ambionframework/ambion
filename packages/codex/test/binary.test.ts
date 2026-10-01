/**
 * The real `codex` binary on a scripted model. A local endpoint speaks the
 * Responses API and plays one reply for each request. Every other part of
 * the path runs as it does in production: the binary, its MCP client, the
 * room tools server, the bridge, and a room over a journal.
 *
 * Some assertions state what Codex does today, and a later change flips
 * them. Each one carries a comment that starts with "Today".
 */

import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	defineTool,
	type Execution,
	isSaid,
	type RoomNotification,
	startRoom,
	type TraceStep,
} from '@ambionframework/ambion';
import { memoryJournals } from '@ambionframework/journal';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { type CodexOptions, codex } from '../src/index.ts';
import { HARNESS_NOTE } from '../src/options.ts';
import { apiKeyLogin, codexOn, HOST_MARKER, hasBinary, MODEL } from './binary.ts';
import { type Reply, type ResponsesRequest, toolsOf, USAGE } from './responses.ts';

/** How long a test may take. The binary starts in about a second, and a loaded host takes longer. */
const TEST_MS = 60_000;

const NAMESPACE = 'mcp__ambion';

/**
 * Under nativeTools 'codex' the binary keeps its plugin features. They sync a marketplace
 * from GitHub and ask chatgpt.com. The home of the test switches them off.
 */
const NO_SYNC = '[features]\nplugins = false\nremote_plugin = false\n';

/** A sentence of the mechanism text of the room. It marks the seat text. */
const MECHANISM = 'You are an agent seated in a room';

const priya = defineHuman({ name: 'priya', identity: 'Project manager. Asks the questions.' });

const lookup = defineTool({
	name: 'lookup',
	description: 'Look up one record.',
	parameters: Type.Object({ id: Type.String() }),
	execute: () => 'found r1',
});

const say = (text: string): Reply => ({ call: 'say', namespace: NAMESPACE, args: { text } });

/** Open a room with one default seat on the binary. The room stops when the test ends. */
async function roomOn(
	execution: Execution,
	options: { tools?: boolean; native?: Partial<CodexOptions>; instructions?: string } = {},
) {
	const steps: TraceStep[] = [];
	const runtime = createRuntime({
		storage: memoryJournals(),
		execution,
		logger: (record) => void steps.push(record.step),
	});
	const agent = defineAgent({
		name: 'gpt',
		identity: 'Answers what is asked.',
		executor: codex({
			instructions: options.instructions ?? 'Answer in one sentence.',
			model: MODEL,
			...(options.tools ? { tools: [lookup] } : {}),
			...options.native,
		}),
	});
	const room = stopAtEnd(
		await startRoom({ name: `binary-${process.pid}-${Date.now()}`, agents: [agent], runtime }),
	);
	const events: RoomNotification[] = [];
	room.subscribe((event) => void events.push(event));
	return { visit: await room.visit(priya), room, events, steps };
}

/** The text of each input item with a role, in order. */
function textsOf(request: ResponsesRequest, role: string): string[] {
	return request.input.flatMap((item) =>
		item.role === role && Array.isArray(item.content)
			? [(item.content as { text?: string }[]).map((part) => part.text ?? '').join('')]
			: [],
	);
}

/** The text of each part of each input item with a role, in order. Codex can join several parts in one item. */
function partsOf(request: ResponsesRequest, role: string): string[] {
	return request.input.flatMap((item) =>
		item.role === role && Array.isArray(item.content)
			? (item.content as { text?: string }[]).map((part) => part.text ?? '')
			: [],
	);
}

/** An instruction text with the characters that a config string and a file could mangle. */
const AWKWARD =
	'Say "yes" or \\no\\.\nSecond line: tab\t, quote \', café, 日本語, 🙂, \\n, # not a comment.';

/** Run one exchange on the binary, and give the developer texts of its first request. */
async function developerTexts(native: Partial<CodexOptions>): Promise<string[]> {
	const on = await codexOn([say('hello room'), { text: 'done' }], undefined, { config: NO_SYNC });
	try {
		const { visit } = await roomOn(on.execution, { instructions: AWKWARD, native });
		await (await visit.send({ text: 'Is the plan ready?' })).waitForClose();
		const [request] = on.responses.requests as [ResponsesRequest];
		expect(on.responses.others).toEqual([]);
		expect(on.outbound).toEqual([]);
		return partsOf(request, 'developer');
	} finally {
		await on.close();
	}
}

/** The message items of a request. The tool list changes between requests, and the messages do not. */
const messagesOf = (request: ResponsesRequest | undefined) =>
	(request?.input ?? []).filter((item) => item.type === 'message');

/** The thread that a request belongs to. */
const threadOf = (request: ResponsesRequest | undefined): unknown =>
	(request?.client_metadata as { thread_id?: string } | undefined)?.thread_id;

/** The names of native tools of Codex. None may reach a default seat. */
const NATIVE = [
	'exec_command',
	'write_stdin',
	'apply_patch',
	'shell',
	'shell_command',
	'local_shell',
	'web_search',
	'view_image',
	'update_plan',
	'request_user_input',
	'exec',
	'wait',
	'node_repl',
	'image_generation',
	'spawn_agent',
];

// CI runs on a platform with a bundled binary, so a lookup that fails there fails the file.
describe.skipIf(!hasBinary && process.env.CI === undefined)(
	'the real codex binary on a scripted model',
	() => {
		it(
			'speaks through say, reports the usage of the endpoint, and shows the model only the room tools',
			async () => {
				const on = await codexOn([say('hello room'), { text: 'done' }]);
				try {
					const { visit, room, events } = await roomOn(on.execution, { tools: true });
					const exchange = await visit.send({ text: 'Is the plan ready?' });
					await exchange.waitForClose();

					// The line reaches the record, and the activation reports the usage.
					const spoken = (await room.read()).messages.filter(isSaid);
					expect(spoken.map((message) => [message.from, message.text])).toEqual([
						['priya', 'Is the plan ready?'],
						['gpt', 'hello room'],
					]);
					expect(on.responses.requests).toHaveLength(2);
					expect(on.responses.overrun()).toBe(0);
					expect(events.filter((event) => event.type === 'activation_end')).toEqual([
						expect.objectContaining({
							seat: 'gpt',
							said: true,
							usage: {
								input: 2 * (USAGE.input - USAGE.cached),
								cacheRead: 2 * USAGE.cached,
								cacheWrite: 0,
								output: 2 * USAGE.output,
							},
						}),
					]);
					expect(events.filter((event) => event.type === 'error')).toEqual([]);

					const [first, second] = on.responses.requests as [ResponsesRequest, ResponsesRequest];

					// The model sees the room tools, the tool of the seat, and the three MCP helpers.
					const tools = toolsOf(first);
					expect(tools).toEqual({
						functions: ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource'],
						[NAMESPACE]: ['dismiss', 'lookup', 'recall', 'say', 'schedule', 'seat', 'unseat'],
					});
					const named = JSON.stringify([first.tools, first.input.filter((i) => i.tools)]);
					for (const native of NATIVE) expect(named).not.toContain(`"name":"${native}"`);
					// Today Codex lists the tools in an `additional_tools` input item, and `tools` stays empty.
					expect(first.tools).toEqual([]);

					// The instructions file replaces the base prompt of Codex. The seat text is the first
					// developer message, and none starts with "You are Codex".
					// Today Codex puts that message in the input, and the top-level `instructions` stays empty.
					expect(first.instructions ?? '').toBe('');
					const developer = textsOf(first, 'developer');
					expect(developer[0]?.startsWith(HARNESS_NOTE)).toBe(true);
					expect(developer[0]).toContain(MECHANISM);
					expect(developer[0]).toContain('Answer in one sentence.');
					expect(developer.filter((text) => text.startsWith('You are Codex'))).toEqual([]);
					// Today Codex adds the skills of its home as a developer message.
					expect(developer.join('\n')).toContain('<skills_instructions>');
					// The last user message holds the view alone.
					const prompt = textsOf(first, 'user').at(-1);
					expect(prompt).toContain('Is the plan ready?');
					expect(prompt?.startsWith(HARNESS_NOTE)).toBe(false);
					expect(prompt).not.toContain(MECHANISM);
					expect(prompt).not.toContain('Answer in one sentence.');

					// The model called the room tool by name and namespace, and the result reached it.
					expect(second.input.slice(-2)).toEqual([
						expect.objectContaining({ type: 'function_call', name: 'say', namespace: NAMESPACE }),
						expect.objectContaining({ type: 'function_call_output', call_id: 'call_0' }),
					]);
					expect(JSON.stringify(second.input.at(-1))).toContain('said #');
					expect(on.responses.others).toEqual([]);

					// The seat runs in its own home. The config and the instructions of the host user
					// reach it nowhere: the provider is not rerouted, the server of the host never starts,
					// and the instructions of the host appear in no request.
					expect(on.leaked()).toBe(false);
					expect(JSON.stringify(on.responses.requests)).not.toContain(HOST_MARKER);
					expect(on.outbound).toEqual([]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'sends the seat text as one developer text in both modes of native tools, whatever characters it holds',
			async () => {
				const work = mkdtempSync(join(tmpdir(), 'ambion-codex-work-'));
				try {
					const none = await developerTexts({ nativeTools: 'none' });
					const native = {
						nativeTools: 'codex',
						workingDirectory: work,
						approvalPolicy: 'never',
					} as const;
					const codex = await developerTexts(native);
					// Under 'none' the seat text replaces the prompt of Codex, and it is the first text.
					const seat = none[0];
					expect(seat?.startsWith(HARNESS_NOTE)).toBe(true);
					expect(seat).toContain(AWKWARD);
					// Under 'codex' the same text follows the prompt of Codex, which teaches the native tools.
					expect(codex[0]).toMatch(/^You are Codex/);
					expect(codex).toContain(seat);
				} finally {
					rmSync(work, { recursive: true, force: true });
				}
			},
			TEST_MS,
		);

		it(
			'runs on the login of the host through a link, and leaves the file as it was',
			async () => {
				const key = 'sk-key-of-the-host';
				const login = apiKeyLogin(key);
				const on = await codexOn([say('hello room'), { text: 'done' }], undefined, {
					hostLogin: login,
					signIn: true,
				});
				try {
					const { visit } = await roomOn(on.execution);
					const exchange = await visit.send({ text: 'Is the plan ready?' });
					await exchange.waitForClose();

					// Every request carries the key of the host login.
					expect(on.responses.requests).toHaveLength(2);
					const sent = on.responses.headers.map((headers) => headers.authorization);
					expect(sent).toEqual(sent.map(() => `Bearer ${key}`));
					// The seat home links the file. The binary did not refresh or rewrite it.
					const host = join(on.hostHome, '.codex', 'auth.json');
					const link = join(on.home, 'auth.json');
					expect(lstatSync(link).isSymbolicLink()).toBe(true);
					expect(realpathSync(link)).toBe(realpathSync(host));
					expect(readFileSync(host, 'utf8')).toBe(login);
					expect(on.responses.others).toEqual([]);
					expect(on.outbound).toEqual([]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'resumes the Codex thread for a line that lands during a pass, and sends the delta',
			async () => {
				let send: (() => Promise<unknown>) | undefined;
				const on = await codexOn(
					[say('first'), { text: 'done' }, say('second'), { text: 'done' }],
					async (index) => {
						// The line lands after the first say, while the pass waits for its last reply.
						if (index === 1) await send?.();
					},
				);
				try {
					const { visit, steps } = await roomOn(on.execution);
					send = () => visit.send({ text: 'Also name the owner.' });
					const exchange = await visit.send({ text: 'Is the plan ready?' });
					await exchange.waitForClose();

					const passes = steps.flatMap((step) => (step.type === 'pass' ? [step.input] : []));
					expect(passes).toEqual(['view', 'delta']);
					expect(on.responses.requests).toHaveLength(4);
					const [one, , three] = on.responses.requests;

					// The second pass runs on the same thread: its request holds the items of the first.
					expect(threadOf(three)).toBeDefined();
					expect(threadOf(three)).toBe(threadOf(one));
					const first = messagesOf(one);
					expect(messagesOf(three).slice(0, first.length)).toEqual(first);
					const delta = textsOf(three as ResponsesRequest, 'user').at(-1);
					expect(delta).toContain('Also name the owner.');
					expect(delta?.startsWith(HARNESS_NOTE)).toBe(false);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);
	},
);
