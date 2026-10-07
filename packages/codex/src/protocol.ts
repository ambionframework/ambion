/**
 * The part of the Codex app-server protocol that the executor uses.
 *
 * These types are hand-written from the experimental TypeScript bindings
 * that `codex app-server generate-ts --experimental` printed for codex-cli
 * 0.160.1. The package pins that version, so the bindings are the contract.
 * A field that the executor never reads is left out.
 */

/** A JSON-RPC error. A server request that the seat refuses gets one. */
export const REFUSED = -32601;

/** The text of one input: the prompt, a delta, or a steered line. */
export interface UserInput {
	readonly type: 'text';
	readonly text: string;
	readonly text_elements: readonly never[];
}

/** One tool of the seat, as `thread/start` takes it. */
export interface DynamicToolSpec {
	readonly type: 'function';
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

/** One part of the result that the activation hands back for a tool call. */
export type DynamicToolOutput =
	| { readonly type: 'inputText'; readonly text: string }
	| { readonly type: 'inputImage'; readonly imageUrl: string };

/** The server request that asks the host to run one tool of the seat. */
export interface DynamicToolCallParams {
	readonly threadId: string;
	readonly turnId: string;
	readonly callId: string;
	readonly namespace: string | null;
	readonly tool: string;
	readonly arguments: unknown;
}

/** The answer to `item/tool/call`. */
export interface DynamicToolCallResponse {
	readonly contentItems: readonly DynamicToolOutput[];
	readonly success: boolean;
}

/** The thread fields that the activation reads. `path` is the rollout file. */
interface ThreadInfo {
	readonly id: string;
	readonly path: string | null;
	readonly cliVersion: string;
}

/** What `thread/start` and `thread/resume` answer. */
export interface ThreadOpened {
	readonly thread: ThreadInfo;
	readonly model: string;
	readonly cwd: string;
	readonly approvalPolicy: string | Record<string, unknown>;
	readonly sandbox: { readonly type: string };
}

/** The parameters of `thread/start`. `thread/resume` takes the same without `dynamicTools`. */
export interface ThreadParams {
	readonly cwd: string;
	readonly sandbox: 'read-only';
	readonly approvalPolicy: 'never';
	readonly model: string;
	readonly baseInstructions: string;
}

/** The kinds of failure that carry the HTTP status of the provider. */
export type CodexErrorInfo = string | Record<string, { readonly httpStatusCode?: number | null }>;

/** How a pass failed. */
export interface TurnError {
	readonly message: string;
	readonly codexErrorInfo?: CodexErrorInfo | null;
}

/** A Codex turn, which is one pass. `turn/start` answers one, and `turn/completed` reports it. */
export interface Turn {
	readonly id: string;
	readonly status: 'completed' | 'failed' | 'interrupted' | 'inProgress';
	readonly error?: TurnError | null;
}

/** An item of a thread. Every item has a type and an id. */
export interface ThreadItem {
	readonly type: string;
	readonly id: string;
}

/** The items of a thread that a seat produces. Any other type is a native tool. */
export type KnownItem =
	| { readonly type: 'userMessage'; readonly id: string; readonly clientId: string | null }
	| { readonly type: 'agentMessage'; readonly id: string; readonly text: string }
	| { readonly type: 'reasoning'; readonly id: string; readonly summary: readonly string[] }
	| {
			readonly type: 'dynamicToolCall';
			readonly id: string;
			readonly namespace: string | null;
			readonly tool: string;
			readonly arguments: unknown;
			readonly status: 'inProgress' | 'completed' | 'failed';
			readonly contentItems: readonly DynamicToolOutput[] | null;
			readonly success: boolean | null;
	  };

const KNOWN_ITEMS: ReadonlySet<string> = new Set<KnownItem['type']>([
	'userMessage',
	'agentMessage',
	'reasoning',
	'dynamicToolCall',
]);

/** The item as one of the known types, or nothing when its type is another. */
export function knownItem(item: ThreadItem): KnownItem | undefined {
	return KNOWN_ITEMS.has(item.type) ? (item as KnownItem) : undefined;
}

/** The tokens of one model request or of a whole thread. Cached and cache-write tokens count inside the input. */
export interface TokenBreakdown {
	readonly inputTokens: number;
	readonly cachedInputTokens: number;
	readonly cacheWriteInputTokens: number;
	readonly outputTokens: number;
}

/** The notifications that the activation reads, by method, with their parameters. */
export interface NotificationParams {
	'turn/started': { readonly threadId: string; readonly turn: Turn };
	'turn/completed': { readonly threadId: string; readonly turn: Turn };
	'item/started': {
		readonly threadId: string;
		readonly turnId: string;
		readonly item: ThreadItem;
	};
	'item/completed': {
		readonly threadId: string;
		readonly turnId: string;
		readonly item: ThreadItem;
	};
	'item/agentMessage/delta': {
		readonly threadId: string;
		readonly turnId: string;
		readonly itemId: string;
		readonly delta: string;
	};
	'item/reasoning/summaryTextDelta': {
		readonly threadId: string;
		readonly turnId: string;
		readonly itemId: string;
		readonly delta: string;
		readonly summaryIndex: number;
	};
	'thread/tokenUsage/updated': {
		readonly threadId: string;
		readonly turnId: string;
		readonly tokenUsage: { readonly total: TokenBreakdown; readonly last: TokenBreakdown };
	};
	error: {
		readonly threadId: string;
		readonly error: TurnError;
		readonly willRetry: boolean;
	};
	warning: { readonly threadId: string | null; readonly message: string };
	configWarning: { readonly summary: string; readonly details: string | null };
	deprecationNotice: { readonly summary: string; readonly details: string | null };
}

/** One notification: its method and the parameters that the method carries. */
export type Notification = {
	[M in keyof NotificationParams]: { readonly method: M; readonly params: NotificationParams[M] };
}[keyof NotificationParams];

const KNOWN: ReadonlySet<string> = new Set<keyof NotificationParams>([
	'turn/started',
	'turn/completed',
	'item/started',
	'item/completed',
	'item/agentMessage/delta',
	'item/reasoning/summaryTextDelta',
	'thread/tokenUsage/updated',
	'error',
	'warning',
	'configWarning',
	'deprecationNotice',
]);

/** The notification of a message from the server, or nothing when the activation ignores its method. */
export function notificationOf(method: string, params: unknown): Notification | undefined {
	return KNOWN.has(method) ? ({ method, params } as Notification) : undefined;
}

/** The text input for one message. */
export function textInput(text: string): UserInput[] {
	return [{ type: 'text', text, text_elements: [] }];
}
