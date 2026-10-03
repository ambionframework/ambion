/**
 * The real `codex app-server` on a scripted model. A local endpoint speaks
 * the Responses API and plays one reply for each request. Every other part
 * of the path runs as it does in production: the binary, its dynamic tools,
 * and a room over a journal.
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
	definePerson,
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
import { openWorkspace } from '@ambionframework/workspace';
import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { type Connect, type Connection, RpcError, spawnAppServer } from '../src/app-server.ts';
import { type CodexOptions, codex } from '../src/index.ts';
import { SEAT_NOTE } from '../src/options.ts';
import {
	apiKeyLogin,
	codexOn,
	HOST_MARKER,
	hasBinary,
	holding,
	kill,
	MODEL,
	runningWith,
	SKILL_MARKER,
	seesProcesses,
} from './binary.ts';
import { deltaInput, driven, viewInput } from './drive.ts';
import { type Reply, type ResponsesRequest, toolsOf, USAGE } from './responses.ts';
import { seat, until } from './support.ts';

/** How long a test may take. The binary starts in about a second, and a loaded host takes longer. */
const TEST_MS = 60_000;

/** The version of the Codex binary that the package pins. */
const PINNED = (
	JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
		dependencies: Record<string, string>;
	}
).dependencies['@openai/codex'];

/** A reasoning summary longer than the 280 characters that the default trace policy keeps. */
const THOUGHT = 'Check the pour schedule against the weather before the answer. '.repeat(8).trim();

/** A key that Codex does not know. It warns, and the warning names the key. */
const UNKNOWN_KEY = 'ambion_unknown_setting';

/** The names of the system skills that Codex 0.159.2 lists in its skills block. */
const SKILL_NAMES = /imagegen|skill-creator|plugin-creator|openai-docs/;

/**
 * The warning notices of a trace. A default seat produces none, except the
 * note that a host has no `bwrap` on its `PATH`. The seat runs no command, so
 * the sandbox helper never runs, and the note depends on the host.
 */
const warningsOf = (steps: readonly TraceStep[]) =>
	steps.flatMap((step) =>
		step.type === 'notice' && step.level === 'warning' && !step.text.includes('bubblewrap')
			? [step]
			: [],
	);

/** A sentence of the mechanism text of the room. It marks the seat text. */
const MECHANISM = 'You are an agent seated in a room';

const priya = definePerson({ name: 'priya', identity: 'Project manager. Asks the questions.' });

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

const say = (text: string): Reply => ({ call: 'say', args: { text } });

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

/**
 * What a watched connection saw: each process it spawned, each steer that Codex took, and each
 * request that Codex refused.
 */
function watched(options: { delayCompleted?: number } = {}) {
	const seen = {
		spawned: 0,
		/** The `turn/steer` requests that Codex answered. The line then waits in the turn. */
		steered: 0,
		/** Whether the server reported the end of a turn, though the host may not have heard yet. */
		completed: false,
		rejected: [] as { method: string; code: number; message: string }[],
	};
	const connect: Connect = (launch, handlers) => {
		seen.spawned += 1;
		const inner = spawnAppServer(launch, {
			...handlers,
			notification: (method, params) => {
				if (method === 'turn/completed') seen.completed = true;
				// A delay holds the end of the turn back, so a line can land after the server finished it.
				if (method === 'turn/completed' && options.delayCompleted !== undefined) {
					setTimeout(() => handlers.notification(method, params), options.delayCompleted);
				} else {
					handlers.notification(method, params);
				}
			},
		});
		const connection: Connection = {
			request: async (method, params) => {
				try {
					const result = await inner.request(method, params);
					if (method === 'turn/steer') seen.steered += 1;
					return result;
				} catch (error) {
					if (error instanceof RpcError) {
						seen.rejected.push({ method, code: error.code, message: error.message });
					}
					throw error;
				}
			},
			notify: (method, params) => inner.notify(method, params),
			stderr: () => inner.stderr(),
			close: () => inner.close(),
		};
		return connection;
	};
	return { connect, seen };
}

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

					// The model sees the room tools and the tool of the seat as functions, and nothing else.
					// Codex adds no `exec`, `wait`, or MCP helper tool.
					const tools = toolsOf(first);
					expect(tools).toEqual({
						functions: ['dismiss', 'lookup', 'recall', 'say', 'schedule', 'seat', 'unseat'],
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
					expect(developer[0]?.startsWith(SEAT_NOTE)).toBe(true);
					expect(developer[0]).toContain(MECHANISM);
					expect(developer[0]).toContain('Answer in one sentence.');
					expect(developer.filter((text) => text.startsWith('You are Codex'))).toEqual([]);
					// The config removes the skills block, and with it every system skill name.
					expect(JSON.stringify(on.responses.requests)).not.toContain('skills_instructions');
					expect(JSON.stringify(on.responses.requests)).not.toMatch(SKILL_NAMES);
					// The last user message holds the view alone.
					const prompt = textsOf(first, 'user').at(-1);
					expect(prompt).toContain('Is the plan ready?');
					expect(prompt?.startsWith(SEAT_NOTE)).toBe(false);
					expect(prompt).not.toContain(MECHANISM);
					expect(prompt).not.toContain('Answer in one sentence.');

					// The model called the room tool by name, and the result reached it.
					expect(second.input.slice(-2)).toEqual([
						expect.objectContaining({ type: 'function_call', name: 'say' }),
						expect.objectContaining({ type: 'function_call_output', call_id: 'call_0' }),
					]);
					expect(JSON.stringify(second.input.at(-1))).toContain('said #');
					expect(on.responses.others).toEqual([]);

					// The seat runs in its own home. The config and the instructions of the host user
					// reach it nowhere: the provider is not rerouted, the server of the host never starts,
					// and the instructions of the host appear in no request.
					expect(on.leaked()).toBe(false);
					expect(JSON.stringify(on.responses.requests)).not.toContain(HOST_MARKER);
					// The private HOME hides the skills of the host user: Codex discovers skills under
					// `$HOME/.agents/skills`, and the seat HOME holds none.
					expect(JSON.stringify(on.responses.requests)).not.toContain(SKILL_MARKER);
					expect(JSON.stringify(on.responses.requests)).not.toContain('host-trap');
					expect(existsSync(join(on.home, 'home'))).toBe(true);
					expect(on.outbound).toEqual([]);

					// Codex warns about the setting it does not know, and the trace keeps the warning.
					const notices = steps.flatMap((step) => (step.type === 'notice' ? [step] : []));
					expect(notices).toContainEqual(
						expect.objectContaining({
							level: 'warning',
							text: expect.stringContaining(UNKNOWN_KEY),
						}),
					);
					// Codex reports the setting again when it opens the thread, and the trace keeps one notice.
					expect(notices.filter((notice) => notice.text.includes(UNKNOWN_KEY))).toHaveLength(1);
					// One notice joins the trace to the rollout file of Codex: its path holds the thread id
					// and the file holds every item of the thread.
					const [thread, ...more] = notices.filter((notice) => notice.text === 'Codex thread');
					expect(more).toEqual([]);
					const rollout = thread?.data?.rollout;
					expect(thread).toMatchObject({ level: 'info', data: { home: on.home } });
					expect(rollout).toMatch(
						/\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[\dT-]+-[\w-]+\.jsonl$/,
					);
					// Codex reports the real path of its home. On macOS the temporary directory is a link.
					expect(String(rollout).startsWith(realpathSync(on.home))).toBe(true);
					expect(existsSync(String(rollout))).toBe(true);
					expect(String(rollout)).toContain(`-${String(thread?.data?.thread)}.jsonl`);
					expect(readFileSync(String(rollout), 'utf8')).toContain(String(thread?.data?.thread));
					expect(threadOf(on.responses.requests[0])).toBe(thread?.data?.thread);

					// One session step names what the thread started with. The scripted provider takes a
					// key from the environment, so the server reports no account.
					const sessions = steps.flatMap((step) => (step.type === 'session' ? [step] : []));
					expect(sessions).toEqual([
						{
							type: 'session',
							name: 'codex',
							version: PINNED,
							model: MODEL,
							cwd: expect.stringContaining('ambion-codex-'),
							session: thread?.data?.thread,
							auth: 'none',
							permissionMode: 'never, readOnly',
							tools: ['say', 'schedule', 'seat', 'unseat', 'dismiss', 'recall', 'lookup'],
							servers: [{ name: 'node_repl', status: 'disabled' }],
							activation: expect.any(String),
							pass: expect.any(Number),
							at: expect.any(String),
							index: expect.any(Number),
						},
					]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'sends an image from a tool of the seat to the model, and keeps the tool list as it was',
			async () => {
				const on = await codexOn([{ call: 'look', args: {} }, say('a pixel'), { text: 'done' }]);
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
						functions: ['dismiss', 'look', 'recall', 'say', 'schedule', 'seat', 'unseat'],
					});
					const named = JSON.stringify([first.tools, first.input.filter((i) => i.tools)]);
					for (const native of NATIVE) expect(named).not.toContain(`"name":"${native}"`);
					expect(on.responses.others).toEqual([]);
					expect(on.outbound).toEqual([]);
					// Codex 0.159.2 knows every key of the recipe, so a default seat gets no warning.
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
					{ call: 'write', args: { path: 'note.txt', content: 'pour at noon' } },
					{ call: 'bash', args: { command: 'cat note.txt' } },
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
					// The workspace tools sit beside the room tools. Codex lists nothing else: no native tool.
					expect(toolsOf(first)).toEqual({
						functions: [
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
						env.readTextFile('/home/gpt/note.txt'),
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
				expect(texts[0]?.startsWith(SEAT_NOTE)).toBe(true);
				expect(texts[0]).toContain(AWKWARD);
				expect(texts.filter((text) => text.startsWith('You are Codex'))).toEqual([]);
			},
			TEST_MS,
		);

		it.skipIf(!seesProcesses)(
			'fails the pass as transient, with the end of the standard error, when the process dies mid request',
			async () => {
				const held = holding(0);
				const on = await codexOn([say('hello room'), { text: 'done' }], held.onRequest, {
					stderrLine: 'wrapper: codex starts',
				});
				try {
					const run = driven(on);
					const state = run.activate();
					const passing = state.pass(viewInput());
					await held.open;
					for (const pid of runningWith(on.home)) kill(pid);
					const result = await passing;
					state.close();

					expect(result).toMatchObject({ failed: true, cause: 'transient' });
					const message = result.failed ? (result.message ?? '') : '';
					expect(message).toContain('was stopped by SIGKILL');
					expect(message).toContain('wrapper: codex starts');
					expect(run.events).toContainEqual(
						expect.objectContaining({ type: 'error', seat: 'gpt', cause: 'transient' }),
					);
					expect(on.responses.requests).toHaveLength(1);
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
					const { visit, steps } = await roomOn(on.execution);
					const exchange = await visit.send({ text: 'Is the plan ready?' });
					await exchange.waitForClose();

					// The session step names the type of the account, and never the key.
					expect(steps).toContainEqual(
						expect.objectContaining({ type: 'session', auth: 'apiKey' }),
					);
					expect(JSON.stringify(steps)).not.toContain(key);
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
			'logs in with CODEX_API_KEY, and writes no auth.json',
			async () => {
				const key = 'sk-key-of-the-environment';
				const on = await codexOn([say('hello room'), { text: 'done' }], undefined, {
					signIn: true,
					apiKey: key,
				});
				try {
					const { visit, steps } = await roomOn(on.execution);
					const exchange = await visit.send({ text: 'Is the plan ready?' });
					await exchange.waitForClose();

					expect(steps).toContainEqual(
						expect.objectContaining({ type: 'session', auth: 'apiKey' }),
					);
					expect(JSON.stringify(steps)).not.toContain(key);
					const sent = on.responses.headers.map((headers) => headers.authorization);
					expect(sent).toHaveLength(2);
					expect(sent).toEqual(sent.map(() => `Bearer ${key}`));
					// The ephemeral store keeps the key out of the home.
					expect(existsSync(join(on.home, 'auth.json'))).toBe(false);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'steers a line that lands mid tool call into the same turn: one pass, consumed, and the line in the next request',
			async () => {
				let send: (() => Promise<unknown>) | undefined;
				const slow = defineTool({
					name: 'slow',
					description: 'Take a while.',
					parameters: Type.Object({}),
					execute: async () => {
						await send?.();
						// The send ends at the journal. The tool returns once Codex holds the line in the turn.
						await until(() => watch.seen.steered === 1, 'the steer');
						return 'slept';
					},
				});
				const watch = watched();
				const on = await codexOn(
					[{ call: 'slow', args: {} }, say('first'), { text: 'done' }],
					undefined,
					{ connect: watch.connect },
				);
				try {
					const { visit, room, steps } = await roomOn(on.execution, { extraTools: [slow] });
					send = () => visit.send({ text: 'Also name the owner.' });
					const exchange = await visit.send({ text: 'Is the plan ready?' });
					await exchange.waitForClose();

					const passes = steps.flatMap((step) => (step.type === 'pass' ? [step.input] : []));
					expect(passes).toEqual(['view']);
					const steers = steps.filter((step) => step.type === 'steer');
					expect(steers).toEqual([expect.objectContaining({ consumed: true })]);
					// Codex runs no extra request: the next request of the turn carries the line.
					expect(on.responses.requests).toHaveLength(3);
					expect(on.responses.overrun()).toBe(0);
					const [first, second] = on.responses.requests as [ResponsesRequest, ResponsesRequest];
					expect(JSON.stringify(first)).not.toContain('Also name the owner.');
					expect(textsOf(second, 'user').at(-1)).toContain('Also name the owner.');
					expect(second.input.some((item) => item.type === 'function_call_output')).toBe(true);
					expect(threadOf(second)).toBe(threadOf(first));
					// The say comes after the line, and the record holds both lines in order.
					const spoken = (await room.read()).messages.filter(isSaid);
					expect(spoken.map((message) => [message.from, message.text])).toEqual([
						['priya', 'Is the plan ready?'],
						['priya', 'Also name the owner.'],
						['gpt', 'first'],
					]);
					expect(on.responses.others).toEqual([]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'steers a line that lands while the final reply is in flight: Codex runs one more request in the same turn',
			async () => {
				let send: (() => Promise<unknown>) | undefined;
				const on = await codexOn(
					[say('first'), { text: 'done' }, say('second'), { text: 'done' }],
					async (index) => {
						// The line lands while the request for the final reply is open.
						if (index === 1) await send?.();
					},
				);
				try {
					const { visit, room, steps } = await roomOn(on.execution);
					send = () => visit.send({ text: 'Also name the owner.' });
					const exchange = await visit.send({ text: 'Is the plan ready?' });
					await exchange.waitForClose();

					const passes = steps.flatMap((step) => (step.type === 'pass' ? [step.input] : []));
					expect(passes).toEqual(['view']);
					expect(steps.filter((step) => step.type === 'steer')).toEqual([
						expect.objectContaining({ consumed: true }),
					]);
					// Today Codex adds one model request for the steered line, in the same turn.
					expect(on.responses.requests).toHaveLength(4);
					const [one, , three] = on.responses.requests as [
						ResponsesRequest,
						ResponsesRequest,
						ResponsesRequest,
					];
					expect(textsOf(three, 'user').at(-1)).toContain('Also name the owner.');
					expect(threadOf(three)).toBe(threadOf(one));
					const spoken = (await room.read()).messages.filter(isSaid);
					expect(spoken.map((message) => message.text)).toEqual([
						'Is the plan ready?',
						'first',
						'Also name the owner.',
						'second',
					]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'leaves a line that arrives after the turn ended for the next delta: Codex answers that no turn is active',
			async () => {
				const on = await codexOn([say('first'), { text: 'done' }]);
				const watch = watched({ delayCompleted: 1_000 });
				try {
					const run = driven(on, seat(), { connect: watch.connect });
					const state = run.activate();
					const passing = state.pass(viewInput());
					await until(() => watch.seen.completed, 'the end of the turn');
					// The server finished the turn, and the host has not heard yet.
					state.steer(1, 2, 'Too late.');
					expect(await passing).toEqual({ failed: false });
					state.close();

					expect(watch.seen.rejected).toEqual([
						{
							method: 'turn/steer',
							code: -32600,
							message: expect.stringContaining('no active turn'),
						},
					]);
					expect(run.steps).toContainEqual({ type: 'steer', seq: 2, consumed: false });
					expect(state.readThrough).toBe(2);
					// Codex ran no request for the line.
					expect(on.responses.requests).toHaveLength(2);
					expect(JSON.stringify(on.responses.requests)).not.toContain('Too late.');
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'keeps one process and one thread across the passes of an activation, and sends the delta',
			async () => {
				const on = await codexOn([say('first'), { text: 'done' }, say('second'), { text: 'done' }]);
				const watch = watched();
				try {
					const run = driven(on, seat(), { connect: watch.connect });
					const state = run.activate();
					expect(await state.pass(viewInput())).toEqual({ failed: false });
					expect(await state.pass(deltaInput())).toEqual({ failed: false });
					const session = state.session;
					state.close();

					expect(watch.seen.spawned).toBe(1);
					const [one, , three] = on.responses.requests as [
						ResponsesRequest,
						ResponsesRequest,
						ResponsesRequest,
					];
					// The second pass runs on the same thread: its request holds the items of the first.
					expect(threadOf(three)).toBe(threadOf(one));
					expect(session?.id).toBe(threadOf(one));
					const first = messagesOf(one);
					expect(messagesOf(three).slice(0, first.length)).toEqual(first);
					const delta = textsOf(three, 'user').at(-1);
					expect(delta).toContain('Also name the owner.');
					expect(delta?.startsWith(SEAT_NOTE)).toBe(false);
					// One session step: the second pass opens no thread.
					expect(run.steps.filter((step) => step.type === 'session')).toHaveLength(1);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'resumes the thread in a new process with the tools it keeps, and replaces the seat text',
			async () => {
				const on = await codexOn([say('one'), { text: 'done' }, say('two'), { text: 'done' }]);
				try {
					const run = driven(on, seat({ instructions: 'FIRST-SEAT-PART.' }));
					const first = run.activate('message:1:gpt:1');
					await first.pass(viewInput());
					const session = first.session;
					first.close();
					const firstSteps = run.steps.length;
					// The first process stops, so the second activation resumes from the disk.
					await vi.waitFor(() => expect(runningWith(on.home)).toEqual([]), { timeout: 10_000 });

					const second = run.activate(
						'message:3:gpt:1',
						seat({ instructions: 'SECOND-SEAT-PART.' }),
					);
					expect(await second.pass(viewInput(session))).toEqual({ failed: false });
					second.close();

					expect(second.session).toEqual(session);
					const [one, , three] = on.responses.requests as [
						ResponsesRequest,
						ResponsesRequest,
						ResponsesRequest,
					];
					expect(threadOf(three)).toBe(threadOf(one));
					// The tools persisted in the rollout, so the resumed thread lists them and the model calls one.
					expect(toolsOf(three)).toEqual(toolsOf(one));
					expect(
						on.responses.requests[3]?.input.some((item) => item.type === 'function_call'),
					).toBe(true);
					// The seat text of the resume replaces the old text.
					const developer = textsOf(three, 'developer').join('\n');
					expect(developer).toContain('SECOND-SEAT-PART.');
					expect(developer).not.toContain('FIRST-SEAT-PART.');
					// The thread keeps its items.
					const before = messagesOf(one).filter((item) => item.role === 'user');
					expect(
						messagesOf(three)
							.filter((item) => item.role === 'user')
							.slice(0, before.length),
					).toEqual(before);
					expect(run.steps.filter((step) => step.type === 'session')).toHaveLength(2);
					// Codex repeats the last usage after a resume. The second activation counts its two requests only.
					const resumed = run.steps.slice(firstSteps);
					expect(resumed.filter((step) => step.type === 'usage')).toHaveLength(2);
					expect(
						resumed.filter(
							(step) =>
								step.type === 'notice' &&
								step.level === 'warning' &&
								!step.text.includes('bubblewrap'),
						),
					).toEqual([]);
					expect(run.events.filter((event) => event.type === 'error')).toEqual([]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'starts a fresh thread when the tools of the activation differ from the tools the thread keeps',
			async () => {
				const on = await codexOn([say('one'), { text: 'done' }, say('two'), { text: 'done' }]);
				try {
					const run = driven(on);
					const first = run.activate('message:1:gpt:1');
					await first.pass(viewInput());
					const session = first.session;
					first.close();
					await vi.waitFor(() => expect(runningWith(on.home)).toEqual([]), { timeout: 10_000 });

					// The second activation binds one tool more.
					const second = run.activate('message:3:gpt:1', seat({ tools: [lookup] }));
					expect(await second.pass(viewInput(session))).toEqual({ failed: false });
					second.close();

					expect(second.session?.id).not.toBe(session?.id);
					const [one, , three] = on.responses.requests as [
						ResponsesRequest,
						ResponsesRequest,
						ResponsesRequest,
					];
					expect(threadOf(three)).not.toBe(threadOf(one));
					expect(toolsOf(three).functions).toContain('lookup');
					expect(toolsOf(one).functions).not.toContain('lookup');
					expect(run.steps).toContainEqual(
						expect.objectContaining({
							text: 'Codex thread not resumed',
							data: { thread: session?.id, reason: 'the thread keeps other tools' },
						}),
					);
					expect(run.events.filter((event) => event.type === 'error')).toEqual([]);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'starts a fresh thread when Codex has no thread of that id',
			async () => {
				const on = await codexOn([say('one'), { text: 'done' }]);
				try {
					const run = driven(on);
					const state = run.activate();
					const bogus = { kind: 'codex', id: '01a0f987-1e2f-7b42-9341-eee65dc6a4f8' };
					expect(await state.pass(viewInput(bogus))).toEqual({ failed: false });
					state.close();
					expect(state.session?.id).not.toBe(bogus.id);
					expect(run.steps).toContainEqual(
						expect.objectContaining({ text: 'Codex thread not resumed' }),
					);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);

		it(
			'interrupts the turn on a cut: the open request closes, the pass reports no failure, and the rollout records the abort',
			async () => {
				const held = holding(0);
				const on = await codexOn([say('hello room'), { text: 'done' }], held.onRequest);
				try {
					const run = driven(on);
					const state = run.activate();
					const passing = state.pass(viewInput());
					await held.open;
					state.cut();
					expect(await passing).toEqual({ failed: false });
					// The process still runs, so the close of the request comes from the interrupt.
					await held.closed;
					if (seesProcesses) expect(runningWith(on.home).length).toBeGreaterThan(0);
					const rollout = String(
						run.steps
							.flatMap((step) => (step.type === 'notice' ? [step.data?.rollout] : []))
							.find(Boolean),
					);
					await vi.waitFor(() => expect(readFileSync(rollout, 'utf8')).toContain('turn_aborted'), {
						timeout: 10_000,
					});
					state.close();
					expect(run.events.filter((event) => event.type === 'error')).toEqual([]);
					expect(on.responses.requests).toHaveLength(1);
				} finally {
					await on.close();
				}
			},
			TEST_MS,
		);
	},
);
