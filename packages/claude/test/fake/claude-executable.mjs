#!/usr/bin/env node
/**
 * A fake Claude Code executable. The Claude Agent SDK spawns it through
 * `pathToClaudeCodeExecutable` and speaks its stream-json control protocol
 * over stdio. The fake plays a scenario and touches no network.
 *
 * The scenario is JSON in `AMBION_FAKE`: `{ turns, log }`. `turns` holds one
 * list of actions for each turn the fake runs. A turn starts when a user
 * message waits, and it ends with a `result`. `log` names a file that takes
 * one JSON line for the arguments, the initialize request, and each
 * permission answer.
 *
 * `rejectResume` makes a resumed start exit before it says anything.
 * `rejectResumeResult` makes a resumed start answer as the real SDK does: a
 * system init, then an error result that says the session is missing. It
 * echoes no user message.
 *
 * Actions:
 * - `{ say }`: call the room tool `say`.
 * - `{ sayUntilLanded }`: call `say`, and call it again when the room answers an error.
 * - `{ call: { tool, args } }`: call one tool of the room server.
 * - `{ text, stream }` and `{ thinking, stream }`: one block, sent whole or as deltas.
 * - `{ awaitUser }`: wait until this many user messages have arrived.
 * - `{ usage }`: add to the running totals the next result carries.
 * - `{ fail: { status, text } }`: end the turn with an error result.
 * - `{ permission: { tool, input } }`: ask the SDK for permission, then run or refuse the tool.
 * - `{ own: { name, input, output } }`: a tool the executable runs itself.
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const config = JSON.parse(process.env.AMBION_FAKE ?? '{"turns":[]}');
const args = process.argv.slice(2);
const resumed = args.find((arg) => arg.startsWith('--resume='))?.slice('--resume='.length);
const session = resumed ?? config.session ?? `fake-session-${process.pid}`;

const log = (entry) => {
	if (config.log !== undefined) appendFileSync(config.log, `${JSON.stringify(entry)}\n`);
};
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let count = 0;
const next = (prefix) => `${prefix}_${process.pid}_${++count}`;
const envelope = (fields) => ({
	...fields,
	parent_tool_use_id: null,
	uuid: next('uuid'),
	session_id: session,
});

const users = [];
let consumed = 0;
let turn = 0;
let running = false;
let cut = false;
let mcpReady = false;
const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const waiters = new Set();
const answers = new Map();

const wake = () => {
	for (const resolve of [...waiters]) resolve();
	waiters.clear();
};
const until = async (ready) => {
	while (!ready() && !cut) await new Promise((resolve) => waiters.add(resolve));
	if (cut) throw new Error('interrupted');
};

log({ argv: process.argv.slice(2), cwd: process.cwd() });
if (resumed !== undefined && config.rejectResume === true) {
	process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
	process.exit(1);
}

/** A control request to the SDK, answered by a control response with the same id. */
async function ask(request) {
	const id = next('fake');
	const answer = new Promise((resolve) => answers.set(id, resolve));
	out({ type: 'control_request', request_id: id, request });
	const response = await Promise.race([answer, until(() => cut).catch(() => undefined)]);
	if (cut) throw new Error('interrupted');
	return response;
}

async function mcp(method, params) {
	const message = { jsonrpc: '2.0', id: next('rpc'), method, ...(params ? { params } : {}) };
	const response = await ask({ subtype: 'mcp_message', server_name: 'ambion', message });
	return response.response.mcp_response.result;
}

async function ensureMcp() {
	if (mcpReady) return;
	mcpReady = true;
	await mcp('initialize', {
		protocolVersion: '2024-11-05',
		capabilities: {},
		clientInfo: { name: 'fake', version: '1' },
	});
	const listed = await mcp('tools/list', {});
	log({ tools: listed.tools });
}

const usage = { input_tokens: 0, output_tokens: 0 };

function assistant(id, content, stop = 'end_turn') {
	out(
		envelope({
			type: 'assistant',
			message: {
				id,
				type: 'message',
				role: 'assistant',
				model: 'fake',
				content,
				stop_reason: stop,
				usage,
			},
		}),
	);
}

function block(kind, value, stream) {
	const id = next('msg');
	const key = kind === 'text' ? 'text' : 'thinking';
	if (stream) {
		const event = (body) => out(envelope({ type: 'stream_event', event: body }));
		event({ type: 'message_start', message: { id } });
		event({ type: 'content_block_start', index: 0, content_block: { type: kind, [key]: '' } });
		for (const word of value.split(/(?<= )/)) {
			const delta =
				kind === 'text'
					? { type: 'text_delta', text: word }
					: { type: 'thinking_delta', thinking: word };
			event({ type: 'content_block_delta', index: 0, delta });
		}
		event({ type: 'content_block_stop', index: 0 });
	}
	assistant(id, [{ type: kind, [key]: value }]);
}

function toolResult(id, content, isError) {
	out(
		envelope({
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
			},
		}),
	);
}

function toolUse(name, input) {
	const id = next('toolu');
	assistant(next('msg'), [{ type: 'tool_use', id, name, input }], 'tool_use');
	return id;
}

async function callRoom(tool, args) {
	await ensureMcp();
	const id = toolUse(`mcp__ambion__${tool}`, args);
	const result = await mcp('tools/call', { name: tool, arguments: args });
	toolResult(id, result.content, result.isError === true);
	return result;
}

async function permission({ tool, input }) {
	const id = toolUse(tool, input);
	const response = await ask({
		subtype: 'can_use_tool',
		tool_name: tool,
		input,
		tool_use_id: id,
		permission_suggestions: [],
	});
	const decision = response.response;
	log({ permission: { tool, id, behavior: decision.behavior } });
	if (decision.behavior === 'allow') toolResult(id, [{ type: 'text', text: 'ran' }], false);
	else toolResult(id, [{ type: 'text', text: decision.message ?? 'denied' }], true);
}

const actions = {
	say: (text) => callRoom('say', { text }),
	sayUntilLanded: async (text) => {
		const first = await callRoom('say', { text });
		if (first.isError === true) await callRoom('say', { text });
	},
	call: ({ tool, args }) => callRoom(tool, args),
	text: (value, action) => block('text', value, action.stream === true),
	thinking: (value, action) => block('thinking', value, action.stream === true),
	awaitUser: (n) => until(() => users.length >= n),
	usage: (added) => {
		for (const key of Object.keys(totals)) totals[key] += added[key] ?? 0;
	},
	permission,
	own: ({ name, input, output }) =>
		toolResult(toolUse(name, input), [{ type: 'text', text: output }], false),
};

function result(fields) {
	out(
		envelope({
			type: 'result',
			subtype: 'success',
			is_error: false,
			duration_ms: 1,
			duration_api_ms: 1,
			num_turns: 1,
			result: '',
			stop_reason: 'end_turn',
			total_cost_usd: totals.cost,
			usage: { input_tokens: totals.input, output_tokens: totals.output },
			modelUsage: {
				fake: {
					inputTokens: totals.input,
					outputTokens: totals.output,
					cacheReadInputTokens: totals.cacheRead,
					cacheCreationInputTokens: totals.cacheWrite,
					webSearchRequests: 0,
					costUSD: totals.cost,
					contextWindow: 1,
					maxOutputTokens: 1,
				},
			},
			permission_denials: [],
			queued_turn_count: 0,
			...fields,
		}),
	);
}

const unresumable = () => resumed !== undefined && config.rejectResumeResult === true;

async function play(list) {
	if (unresumable()) {
		out(envelope({ type: 'system', subtype: 'init' }));
		return result({
			subtype: 'error_during_execution',
			is_error: true,
			errors: [`No conversation found with session ID: ${resumed}`],
		});
	}
	for (const action of list) {
		if (action.fail !== undefined) {
			return result({
				is_error: true,
				result: action.fail.text,
				api_error_status: action.fail.status,
			});
		}
		const [name, value] = Object.entries(action)[0];
		await actions[name](value, action);
	}
	return result({});
}

async function run() {
	running = true;
	consumed = users.length;
	try {
		await play(config.turns[turn] ?? []);
	} catch (error) {
		if (!cut) throw error;
		result({ subtype: 'error_during_execution', is_error: true, errors: ['interrupted'] });
	}
	turn += 1;
	cut = false;
	running = false;
	if (users.length > consumed) void run();
}

function control(id, request) {
	if (request.subtype === 'initialize') log({ initialize: request });
	if (request.subtype === 'interrupt' && running) {
		cut = true;
		wake();
	}
	out({
		type: 'control_response',
		response: {
			subtype: 'success',
			request_id: id,
			response: request.subtype === 'initialize' ? { commands: [], agents: [], models: [] } : {},
		},
	});
}

createInterface({ input: process.stdin }).on('line', (line) => {
	if (line.trim() === '') return;
	const message = JSON.parse(line);
	if (message.type === 'control_request') return control(message.request_id, message.request);
	if (message.type === 'control_response') {
		const resolve = answers.get(message.response.request_id);
		answers.delete(message.response.request_id);
		return resolve?.(message.response);
	}
	if (message.type !== 'user') return;
	users.push(message);
	if (!unresumable()) out({ ...message, isReplay: true, session_id: session });
	wake();
	if (!running) void run();
});

process.stdin.on('end', () => process.exit(0));
