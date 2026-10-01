/**
 * A local endpoint that speaks the OpenAI Responses API, so that a real
 * `codex` binary runs against a scripted model. The script holds one reply
 * for each request, in order. The endpoint records the body of each request.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One reply of the scripted model: assistant text, or a call to a named tool. */
export type Reply =
	| { readonly text: string }
	| {
			readonly call: string;
			readonly args: unknown;
			/** The namespace of an MCP tool, as Codex lists it on the wire. */
			readonly namespace?: string;
	  };

/** The token counts that `response.completed` reports for every reply. */
export interface ReportedUsage {
	readonly input: number;
	readonly cached: number;
	readonly output: number;
	readonly reasoning: number;
}

/** The usage of each scripted reply. */
export const USAGE: ReportedUsage = { input: 120, cached: 20, output: 30, reasoning: 5 };

/** One tool as the model sees it: a plain function, or a namespace that holds functions. */
export interface WireTool {
	readonly type: string;
	readonly name?: string;
	readonly tools?: readonly WireTool[];
	readonly [key: string]: unknown;
}

/** One item of the input array of a request. */
export interface WireItem {
	readonly type?: string;
	readonly role?: string;
	readonly content?: unknown;
	readonly [key: string]: unknown;
}

/** The part of a Responses request that the tests read. */
export interface ResponsesRequest {
	readonly model?: string;
	readonly instructions?: string;
	readonly input: readonly WireItem[];
	readonly tools: readonly WireTool[];
	readonly [key: string]: unknown;
}

/** The tools of a request as the model sees them: namespace name to function names. */
export function toolsOf(request: ResponsesRequest): Record<string, string[]> {
	const listed = request.input.flatMap((item) =>
		item.type === 'additional_tools' ? ((item.tools as readonly WireTool[] | undefined) ?? []) : [],
	);
	return Object.fromEntries(
		[...request.tools, ...listed].map((tool) => [
			tool.name ?? tool.type,
			(tool.tools ?? []).flatMap((inner) => (inner.name === undefined ? [] : [inner.name])).sort(),
		]),
	);
}

/** A running endpoint. */
export interface ScriptedResponses {
	/** The base URL of the provider, with `/v1`. */
	readonly url: string;
	/** The body of each request that took a reply from the script, in arrival order. */
	readonly requests: readonly ResponsesRequest[];
	/** The headers of every request that arrived, probes and other paths included, in arrival order. */
	readonly headers: readonly IncomingHttpHeaders[];
	/** The count of probes: requests that came before the MCP tools were ready. */
	readonly probes: () => number;
	/** The path of each request that was not `POST /v1/responses`. */
	readonly others: readonly string[];
	/** The count of requests that arrived after the script ended. */
	readonly overrun: () => number;
	close(): Promise<void>;
}

/** What the endpoint answers when the script has ended. */
export const SCRIPT_ENDED = 'The script has ended.';

/**
 * The most probes the endpoint sends for one script. A probe that never
 * finds the tools ends, so a binary that never lists them fails the test
 * and does not loop.
 */
const MAX_PROBES = 100;

/** The reply that asks Codex to list MCP resources. It reads nothing and costs no usage. */
const PROBE: Reply = { call: 'list_mcp_resources', namespace: 'functions', args: {} };

const NO_USAGE: ReportedUsage = { input: 0, cached: 0, output: 0, reasoning: 0 };

function itemOf(reply: Reply, id: string): Record<string, unknown> {
	if ('text' in reply) {
		return {
			type: 'message',
			role: 'assistant',
			id: `msg_${id}`,
			content: [{ type: 'output_text', text: reply.text }],
		};
	}
	return {
		type: 'function_call',
		id: `fc_${id}`,
		call_id: `call_${id}`,
		name: reply.call,
		...(reply.namespace === undefined ? {} : { namespace: reply.namespace }),
		arguments: JSON.stringify(reply.args),
	};
}

/** The server-sent events of one reply. */
function eventsOf(reply: Reply, id: string, used: ReportedUsage): string {
	const usage = {
		input_tokens: used.input,
		input_tokens_details: { cached_tokens: used.cached },
		output_tokens: used.output,
		output_tokens_details: { reasoning_tokens: used.reasoning },
		total_tokens: used.input + used.output,
	};
	return [
		{ type: 'response.created', response: { id } },
		{ type: 'response.output_item.done', output_index: 0, item: itemOf(reply, id) },
		{ type: 'response.completed', response: { id, usage } },
	]
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join('');
}

function parsed(text: string): ResponsesRequest {
	const body = JSON.parse(text) as Partial<ResponsesRequest>;
	return { ...body, input: body.input ?? [], tools: body.tools ?? [] };
}

/**
 * Whether the model could call the tool of the reply. Codex starts its MCP
 * servers while it starts the turn, and a loaded host can send the first
 * request before a server is ready. The model then sees no tool of it.
 */
function listsTool(request: ResponsesRequest, reply: Reply | undefined): boolean {
	if (reply === undefined || 'text' in reply || reply.namespace === undefined) return true;
	return toolsOf(request)[reply.namespace]?.includes(reply.call) ?? false;
}

/** Runs when a request takes a reply, before the endpoint answers. It gets the index of the reply. */
export type OnRequest = (index: number) => void | Promise<void>;

/**
 * Start an endpoint on a free port of the loopback interface. When a request
 * does not list the tool that the next reply calls, the endpoint answers with
 * a probe and keeps the reply for the next request.
 */
export async function scriptedResponses(
	script: readonly Reply[],
	onRequest?: OnRequest,
): Promise<ScriptedResponses> {
	const requests: ResponsesRequest[] = [];
	const others: string[] = [];
	const headers: IncomingHttpHeaders[] = [];
	let probes = 0;
	let overrun = 0;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', async () => {
			headers.push(request.headers);
			if (request.method !== 'POST' || request.url !== '/v1/responses') {
				others.push(`${request.method} ${request.url}`);
				response.writeHead(404).end();
				return;
			}
			const body = parsed(Buffer.concat(chunks).toString('utf8'));
			const index = requests.length;
			const reply = script[index];
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			if (!listsTool(body, reply) && probes < MAX_PROBES) {
				probes += 1;
				response.end(eventsOf(PROBE, `probe_${probes}`, NO_USAGE));
				return;
			}
			requests.push(body);
			await onRequest?.(index);
			if (reply === undefined) overrun += 1;
			response.end(eventsOf(reply ?? { text: SCRIPT_ENDED }, String(index), USAGE));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		headers,
		probes: () => probes,
		others,
		overrun: () => overrun,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
