/**
 * The real `codex` binary on a scripted model. A local endpoint speaks the
 * Responses API and plays one reply for each request. Every other part of
 * the path runs as it does in production: the binary, its MCP client, the
 * room tools server, the bridge, and a room over a journal.
 *
 * Some assertions state what Codex does today, and a later change flips
 * them. Each one carries a comment that starts with "Today".
 */

import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
	type AmbionTool,
	createRuntime,
	defineAgent,
	defineHuman,
	defineTool,
	type Execution,
	isSaid,
	type RoomNotification,
	startRoom,
	type TracePolicy,
	type TraceStep,
} from '@ambionframework/ambion';
import { memoryJournals } from '@ambionframework/journal';
import { memoryBackend } from '@ambionframework/just-bash';
import { BACKGROUND_CONTEXT, openWorkspace } from '@ambionframework/workspace';
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

/** A reasoning summary longer than the 280 characters that the default trace policy keeps. */
const THOUGHT = 'Check the pour schedule against the weather before the answer. '.repeat(8).trim();

/** A key that Codex does not know. It warns, and the warning names the key. */
const UNKNOWN_KEY = 'ambion_unknown_setting';

/** The names of the system skills that Codex 0.158.0 lists in its skills block. */
const SKILL_NAMES = /imagegen|skill-creator|plugin-creator|openai-docs/;

/** The warning notices of a trace. A default seat produces none. */
const warningsOf = (steps: readonly TraceStep[]) =>
	steps.flatMap((step) => (step.type === 'notice' && step.level === 'warning' ? [step] : []));

/** A sentence of the mechanism text of the room. It marks the seat text. */
const MECHANISM = 'You are an agent seated in a room';

const priya = defineHuman({ name: 'priya', identity: 'Project manager. Asks the questions.' });

const lookup = defineTool({
	name: 'lookup',
	description: 'Look up one record.',
	parameters: Type.Object({ id: Type.String() }),
	execute: () => 'found r1',
});

/** A 1x1 PNG, base64. */
const PIXEL =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

/** The text that Codex puts in place of an image when the model does not read images. */
const OMITTED = 'image content omitted';

const look = defineTool({
	name: 'look',
	description: 'Look at one frame.',
	parameters: Type.Object({}),
	execute: () => ({
		content: [
			{ type: 'text', text: 'frame at t=1' },
			{ type: 'image', data: PIXEL, mimeType: 'image/png' },
		],
		details: {},
	}),
});

const say = (text: string): Reply => ({ call: 'say', namespace: NAMESPACE, args: { text } });

/** Open a room with one default seat on the binary. The room stops when the test ends. */
async function roomOn(
	execution: Execution,
	options: {
		tools?: boolean;
		extraTools?: readonly AmbionTool[];
		seat?: Partial<CodexOptions>;
		instructions?: string;
		trace?: TracePolicy;
	} = {},
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
			...(options.tools || options.extraTools
				? { tools: [...(options.tools ? [lookup] : []), ...(options.extraTools ?? [])] }
				: {}),
			...options.seat,
		}),
		...(options.trace === undefined ? {} : { trace: options.trace }),
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
async function developerTexts(): Promise<string[]> {
	const on = await codexOn([say('hello room'), { text: 'done' }]);
	try {
		const { visit } = await roomOn(on.execution, { instructions: AWKWARD });
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
				const on = await codexOn([say('hello room'), { text: 'done' }], undefined, {
					config: `${UNKNOWN_KEY} = true`,
				});
				try {
					const { visit, room, events, steps } = await roomOn(on.execution, { tools: true });
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
					// The config removes the skills block, and with it every system skill name.
					expect(JSON.stringify(on.responses.requests)).not.toContain('skills_instructions');
					expect(JSON.stringify(on.responses.requests)).not.toMatch(SKILL_NAMES);
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

					// Codex warns about the setting it does not know, and the trace keeps the warning.
					const notices = steps.flatMap((step) => (step.type === 'notice' ? [step] : []));
					expect(notices).toContainEqual(
						expect.objectContaining({
							level: 'warning',
							text: expect.stringContaining(UNKNOWN_KEY),
						}),
					);
					// One notice joins the trace to the rollout file of Codex: its path holds the thread id
					// and the file holds every item of the thread.
					const [thread, ...more] = notices.filter((notice) => notice.text === 'Codex thread');
					expect(more).toEqual([]);
					const rollout = thread?.data?.rollout;
					expect(thread).toMatchObject({ level: 'info', data: { home: on.home } });
					expect(rollout).toMatch(
						/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[\dT-]+-[\w-]+\.jsonl$/,
					);
					expect(String(rollout).startsWith(on.home)).toBe(true);
					expect(existsSync(String(rollout))).toBe(true);
					expect(String(rollout)).toContain(`-${String(thread?.data?.thread)}.jsonl`);
					expect(readFileSync(String(rollout), 'utf8')).toContain(String(thread?.data?.thread));
					expect(threadOf(on.responses.requests[0])).toBe(thread?.data?.thread);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'sends an image from a tool of the seat to the model, and keeps the tool list as it was',
			async () => {
				const on = await codexOn([
					{ call: 'look', namespace: NAMESPACE, args: {} },
					say('a pixel'),
					{ text: 'done' },
				]);
				try {
					const { visit, steps } = await roomOn(on.execution, { extraTools: [look] });
					await (await visit.send({ text: 'What is in the frame?' })).waitForClose();

					expect(on.responses.requests).toHaveLength(3);
					const [first, second] = on.responses.requests as [ResponsesRequest, ResponsesRequest];
					// The image reaches the model as an `input_image` with the same bytes, and no placeholder.
					const output = second.input.find((item) => item.type === 'function_call_output');
					expect(output?.output).toEqual(
						expect.arrayContaining([
							{ type: 'input_text', text: 'frame at t=1' },
							{ type: 'input_image', image_url: `data:image/png;base64,${PIXEL}` },
						]),
					);
					expect(JSON.stringify(second.input)).not.toContain(OMITTED);
					// The trace keeps the text part and the image part, with the size of the image in place of its bytes.
					const result = steps.find(
						(step) => step.type === 'tool_result' && JSON.stringify(step.output).includes('frame'),
					);
					expect(result).toMatchObject({
						output: [
							{ type: 'text', text: 'frame at t=1' },
							{ type: 'image', mimeType: 'image/png', bytes: expect.any(Number) },
						],
					});
					expect(JSON.stringify(result)).not.toContain(PIXEL);
					// No native tool reads images, so the tool list holds the room tools and the seat tool.
					expect(toolsOf(first)).toEqual({
						functions: ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource'],
						[NAMESPACE]: ['dismiss', 'look', 'recall', 'say', 'schedule', 'seat', 'unseat'],
					});
					const named = JSON.stringify([first.tools, first.input.filter((i) => i.tools)]);
					for (const native of NATIVE) expect(named).not.toContain(`"name":"${native}"`);
					expect(on.responses.others).toEqual([]);
					expect(on.outbound).toEqual([]);
					// Codex 0.158.0 knows every key of the recipe, so a default seat gets no warning.
					expect(warningsOf(steps)).toEqual([]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'answers a call to view_image with unsupported call, because the feature is off, and warns of nothing',
			async () => {
				const on = await codexOn([
					{ call: 'view_image', args: { path: '/etc/hostname' } },
					say('no image'),
					{ text: 'done' },
				]);
				try {
					const { visit, steps } = await roomOn(on.execution);
					await (await visit.send({ text: 'Show the file.' })).waitForClose();

					const second = on.responses.requests[1] as ResponsesRequest;
					const output = second.input.find((item) => item.type === 'function_call_output');
					expect(output?.output).toBe('unsupported call: view_image');
					expect(warningsOf(steps)).toEqual([]);
					expect(on.responses.others).toEqual([]);
					expect(on.outbound).toEqual([]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'gives a seat files and a shell only through the workspace tools, and no native tool',
			async () => {
				const workspace = openWorkspace({ name: 'site', backend: { bash: memoryBackend() } });
				const on = await codexOn([
					{
						call: 'write',
						namespace: NAMESPACE,
						args: { path: 'note.txt', content: 'pour at noon' },
					},
					{ call: 'bash', namespace: NAMESPACE, args: { command: 'cat note.txt' } },
					say('The note reads: pour at noon'),
					{ text: 'done' },
				]);
				try {
					const { visit, steps } = await roomOn(on.execution, {
						seat: { bundles: [workspace.tools()] },
					});
					await (await visit.send({ text: 'Write the note and read it back.' })).waitForClose();

					expect(on.responses.requests).toHaveLength(4);
					const [first, , third] = on.responses.requests as [
						ResponsesRequest,
						ResponsesRequest,
						ResponsesRequest,
					];
					// The workspace tools sit beside the room tools in the namespace of the room server.
					// Codex lists nothing else: no native tool, only its three MCP helpers.
					expect(toolsOf(first)).toEqual({
						functions: ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource'],
						[NAMESPACE]: [
							'bash',
							'cancel',
							'dismiss',
							'edit',
							'ps',
							'read',
							'recall',
							'restore',
							'say',
							'schedule',
							'seat',
							'snapshot',
							'status',
							'unseat',
							'wait',
							'write',
						],
					});
					expect(first.tools).toEqual([]);

					// The file exists in the workspace, in the home of the seat. The port reads it back.
					const note = await workspace.use({ name: 'gpt' }, (env) =>
						env.readTextFile('/home/gpt/note.txt', BACKGROUND_CONTEXT),
					);
					expect(note).toMatchObject({ ok: true, value: 'pour at noon' });

					// The output of the shell reached the model in the next request.
					const outputs = third.input.filter((item) => item.type === 'function_call_output');
					expect(JSON.stringify(outputs.at(-1))).toContain('pour at noon');
					const called = steps.flatMap((step) => (step.type === 'tool_call' ? [step.name] : []));
					expect(called).toEqual(['write', 'bash', 'say']);
					expect(on.responses.others).toEqual([]);
					expect(on.outbound).toEqual([]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it.each([
			{ configured: undefined, sent: 'auto' },
			{ configured: 'concise', sent: 'concise' },
			{ configured: 'detailed', sent: 'detailed' },
			// Today Codex leaves the field out when the summary is none.
			{ configured: 'none', sent: undefined },
		] as const)(
			'sends reasoning.summary $sent for reasoningSummary $configured, and traces the summary the model returns',
			async ({ configured, sent }) => {
				const on = await codexOn([{ ...say('hello room'), reasoning: THOUGHT }, { text: 'done' }]);
				try {
					const { visit, steps } = await roomOn(on.execution, {
						seat: configured === undefined ? {} : { reasoningSummary: configured },
						trace: { thinking: 'full', toolOutput: 'full' },
					});
					await (await visit.send({ text: 'Is the plan ready?' })).waitForClose();

					const [first] = on.responses.requests;
					expect((first?.reasoning as { summary?: string } | undefined)?.summary).toBe(sent);
					// The summary is longer than the 280 characters of the default policy, and arrives whole.
					expect(steps).toContainEqual(
						expect.objectContaining({ type: 'thinking', text: THOUGHT, final: true }),
					);
					expect(on.responses.others).toEqual([]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'sends the seat text as the first developer text, unchanged, whatever characters it holds',
			async () => {
				const texts = await developerTexts();
				// The seat text replaces the prompt of Codex, and it is the first text.
				expect(texts[0]?.startsWith(HARNESS_NOTE)).toBe(true);
				expect(texts[0]).toContain(AWKWARD);
				expect(texts.filter((text) => text.startsWith('You are Codex'))).toEqual([]);
			},
			TEST_MS,
		);

		it(
			'fails the pass as transient, before any model request, when the room tools server cannot start',
			async () => {
				const on = await codexOn([say('hello room'), { text: 'done' }], undefined, {
					brokenRoomServer: true,
				});
				try {
					const { visit, room, events, steps } = await roomOn(on.execution);
					const ended = new Promise<void>((resolve) =>
						room.subscribe((event) => event.type === 'activation_end' && resolve()),
					);
					await visit.send({ text: 'Is the plan ready?' });
					await ended;

					// The required server fails the startup of `codex exec`. No model sees a request.
					expect(on.responses.requests).toEqual([]);
					expect(events).toContainEqual(
						expect.objectContaining({ type: 'error', seat: 'gpt', cause: 'transient' }),
					);
					expect(steps).toContainEqual(
						expect.objectContaining({
							type: 'end',
							failure: expect.objectContaining({
								cause: 'transient',
								message: expect.stringContaining(
									'required MCP servers failed to initialize: ambion',
								),
							}),
						}),
					);
				} finally {
					await on.close();
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
					// Codex waits for the required room server, so every request lists `say`.
					for (const request of on.responses.requests) {
						expect(toolsOf(request)[NAMESPACE]).toContain('say');
					}

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
