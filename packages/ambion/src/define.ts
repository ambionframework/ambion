/**
 * The values you write before a room exists.
 *
 * An agent, a person, a tool, and where a seat sits on the attention scale.
 * None of them starts anything or holds any state: a definition is a value,
 * and the same one is the quiet corner in one room and the one who meets
 * people in another. What each refuses is as much of the contract as what it
 * takes — a name the room can address, and a composition of ordinary tools.
 */
import { IsSchema, type Static, type TSchema, Type } from 'typebox';
import { Check } from 'typebox/value';
import { AmbionError } from './errors.ts';
import type {
	AgentDefinition,
	AgentExecutor,
	AmbionTool,
	HumanDefinition,
	ToolBundle,
	ToolContext,
	ToolExecutionMode,
	ToolResult,
} from './types.ts';

export interface DefineAgentOptions {
	/** Identifies the agent inside a room and on the record. */
	name: string;
	/** The agent's public face — injected into every participant's context as part of the roster. */
	identity: string;
	/** The executor this agent runs on. Build one with the executor package, such as `pi()`. */
	executor: AgentExecutor;
}

/** What `describeExecutor` reads: the fields every executor family shares. */
export interface ExecutorOptions {
	readonly kind: string;
	/** The private half: the agent's own voice, and the home of all judgment. */
	readonly instructions: string;
	/** The agent's own normalized tools. */
	readonly tools?: readonly AmbionTool[];
	/** Composable tool bundles with guidance. Bundles are flattened at definition time. */
	readonly bundles?: readonly ToolBundle[];
	/** The token limit for the record one activation reads. Absent reads the whole record. */
	readonly activationTokenLimit?: number;
	/** How the agent counts tokens against its limit. Absent uses a length estimate. */
	readonly estimateTokens?: (text: string) => number;
}

/**
 * The neutral half of an executor: validated, flattened, and frozen. An
 * executor family adds its own fields to the value this returns.
 */
export function describeExecutor(options: ExecutorOptions): AgentExecutor {
	const input = flattenTools(options.tools, options.bundles);
	const guidance = guidanceOf(options.bundles);
	const tools = Object.freeze(input.map((tool) => captureTool(tool)));
	return Object.freeze({
		kind: options.kind,
		instructions: options.instructions,
		tools,
		...(guidance === undefined ? {} : { guidance }),
		...recordLimit(options.activationTokenLimit, options.estimateTokens),
	});
}

export function defineAgent(options: DefineAgentOptions): AgentDefinition {
	assertName(options.name);
	assertAgentTools(options.name, options.executor.tools);
	return Object.freeze({
		name: options.name,
		identity: options.identity,
		executor: options.executor,
	});
}

/** The record-window fields, validated and written only when a limit is set. */
function recordLimit(
	activationTokenLimit: number | undefined,
	estimateTokens: ((text: string) => number) | undefined,
): { activationTokenLimit?: number; estimateTokens?: (text: string) => number } {
	if (activationTokenLimit === undefined) {
		if (estimateTokens !== undefined)
			throw new Error('An agent estimateTokens needs an activationTokenLimit.');
		return {};
	}
	if (!Number.isSafeInteger(activationTokenLimit) || activationTokenLimit <= 0)
		throw new Error('An agent activationTokenLimit must be a positive integer.');
	if (estimateTokens !== undefined && typeof estimateTokens !== 'function')
		throw new Error('An agent estimateTokens must be a function.');
	return {
		activationTokenLimit,
		...(estimateTokens === undefined ? {} : { estimateTokens }),
	};
}

/** Capture a structural definition at a room boundary without retaining mutable authoring data. */
export function captureAgent(agent: AgentDefinition): AgentDefinition {
	assertName(agent.name);
	const executor = captureExecutor(agent.executor);
	assertAgentTools(agent.name, executor.tools);
	return Object.freeze({
		name: agent.name,
		identity: agent.identity,
		executor,
	});
}

/**
 * Capture one executor at a room boundary. The copy is deep, so a field an
 * executor family adds, such as a model, survives without a name here.
 */
function captureExecutor(executor: AgentExecutor): AgentExecutor {
	const tools = Object.freeze(
		executor.tools.map((tool) => {
			assertTool(tool);
			return captureTool(tool);
		}),
	);
	recordLimit(executor.activationTokenLimit, executor.estimateTokens);
	return capture({ ...executor, tools });
}

export interface DefineHumanOptions {
	name: string;
	/** How the room knows them — agents read it and address them accordingly. */
	identity: string;
	/**
	 * How they read: what a message to them leads with, what to cut, and how
	 * much of one they take. The assigned summary writer reads it when writing
	 * the one message they read at the close of their exchange. What they own is
	 * `identity`, which every seat reads; this reaches the writer alone.
	 */
	preferences?: string;
}

export function defineHuman(options: DefineHumanOptions): HumanDefinition {
	assertName(options.name);
	const preferences = options.preferences?.trim() || undefined;
	return Object.freeze({
		name: options.name,
		identity: options.identity,
		...(preferences === undefined ? {} : { preferences }),
	});
}

export function captureHuman(human: HumanDefinition): HumanDefinition {
	assertName(human.name);
	return Object.freeze({
		name: human.name,
		identity: human.identity,
		...(human.preferences === undefined ? {} : { preferences: human.preferences }),
	});
}

export interface DefineToolOptions<TParameters extends TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	label?: string;
	prepareArguments?: (args: unknown) => Static<TParameters>;
	executionMode?: ToolExecutionMode;
	/**
	 * Return a string (or the full content shape when needed). Throw on failure.
	 * `ctx.agent` identifies the calling agent and `ctx.signal` is the abort
	 * signal the executor gives the tool call. `ctx.room`, `ctx.activation`, and
	 * `ctx.exchange` name the room, the activation, and the open exchange the
	 * call ran in.
	 */
	execute: (
		params: Static<TParameters>,
		ctx: ToolContext,
	) => Promise<string | ToolResult> | string | ToolResult;
}

/**
 * Define one typed tool. The callback receives parsed parameters and the
 * calling agent context. A native Pi tool goes through `fromPiTool`, from
 * `@ambionframework/pi`.
 */
export function defineTool<TParameters extends TSchema>(
	options: DefineToolOptions<TParameters>,
): AmbionTool {
	assertDefineToolOptions(options);
	const parameters = capture(options.parameters);
	const name = options.name;
	const execute = options.execute;
	return Object.freeze({
		name,
		description: options.description,
		parameters,
		label: options.label ?? name,
		...(options.prepareArguments === undefined
			? {}
			: { prepareArguments: options.prepareArguments }),
		...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
		invoke: (params: unknown, context: ToolContext) => {
			if (!Check(parameters, params)) {
				throw new Error(`Invalid arguments for tool '${name}'.`);
			}
			return execute(params, context);
		},
	});
}

/** Copies authoring data while keeping executable and resource values by identity. */
function capture<T>(value: T, seen = new WeakMap<object, unknown>()): T {
	if (typeof value !== 'object' || value === null) return value;
	const prior = seen.get(value);
	if (prior !== undefined) return prior as T;
	const prototype = Object.getPrototypeOf(value);
	if (!copyable(value, prototype)) return value;
	const copy: object = Array.isArray(value) ? [] : Object.create(prototype);
	seen.set(value, copy);
	copyProperties(value, copy, seen);
	return Object.freeze(copy) as T;
}

const copyable = (value: object, prototype: object | null): boolean =>
	Array.isArray(value) || prototype === Object.prototype || prototype === null;

function copyProperties(from: object, to: object, seen: WeakMap<object, unknown>): void {
	for (const key of Reflect.ownKeys(from)) {
		const descriptor = Object.getOwnPropertyDescriptor(from, key);
		if (descriptor === undefined) continue;
		const captured = 'value' in descriptor ? descriptor.value : descriptor.get?.call(from);
		Object.defineProperty(to, key, {
			value: capture(captured, seen),
			writable: false,
			enumerable: descriptor.enumerable,
			configurable: false,
		});
	}
}

/** The room tool that every activation may use to speak. */
export const SAY = {
	name: 'say' as const,
	parameters: Type.Object({
		to: Type.Optional(Type.String({ description: 'A participant name from the roster.' })),
		text: Type.String(),
		refs: Type.Optional(
			Type.Array(
				Type.String({
					description: 'A URI the message cites: a file, a table, a room, or an exchange.',
				}),
			),
		),
	}),
};

/** The room tool that seats one supplied agent. */
export const SEAT = {
	name: 'seat' as const,
	parameters: Type.Object({
		name: Type.String({ description: 'An agent name from the reserve.' }),
	}),
};

/** The room tool that removes one seated agent. */
export const UNSEAT = {
	name: 'unseat' as const,
	parameters: Type.Object({
		name: Type.String({ description: 'A seated agent name.' }),
	}),
};

function flattenTools(
	tools: readonly AmbionTool[] | undefined,
	bundles: readonly ToolBundle[] | undefined,
): AmbionTool[] {
	const flattened: AmbionTool[] = [];
	appendTools(tools === undefined ? [] : tools, flattened, 'tools');
	if (bundles !== undefined) {
		if (!Array.isArray(bundles)) throw new Error('Agent bundles must be an array.');
		for (const bundle of bundles) {
			if (!isRecord(bundle) || !Array.isArray(bundle.tools)) {
				throw new Error('Agent bundles must contain a tools array.');
			}
			appendTools(bundle.tools, flattened, 'bundle');
		}
	}
	return flattened;
}

function appendTools(tools: readonly AmbionTool[], into: AmbionTool[], source: string): void {
	if (!Array.isArray(tools)) throw new Error(`Agent ${source} must be an array.`);
	for (const tool of tools) {
		assertTool(tool);
		into.push(tool);
	}
}

function captureTool(tool: AmbionTool): AmbionTool {
	return Object.freeze({
		name: tool.name,
		description: tool.description,
		parameters: capture(tool.parameters),
		label: tool.label,
		...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
		...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
		invoke: tool.invoke,
	});
}

function guidanceOf(bundles: readonly ToolBundle[] | undefined): string | undefined {
	if (bundles === undefined) return undefined;
	const guidance = bundles
		.map((bundle) => (typeof bundle.guidance === 'string' ? bundle.guidance.trim() : ''))
		.filter((text): text is string => text.length > 0)
		.join('\n\n');
	return guidance || undefined;
}

function assertAgentTools(agent: string, tools: readonly AmbionTool[]): void {
	const names = new Set<string>();
	for (const tool of tools) {
		const name = tool.name;
		if (names.has(name)) {
			throw new AmbionError(
				'invalid_tool',
				`Agent '${agent}' brings duplicate tools named '${name}'.`,
			);
		}
		names.add(name);
		const roomTool = name === SAY.name || name === SEAT.name || name === UNSEAT.name;
		if (roomTool)
			throw new AmbionError(
				'invalid_tool',
				`Agent '${agent}' brings a tool named '${name}': the room supplies it for an activation. Give it another name.`,
			);
	}
}

function assertTool(value: unknown): asserts value is AmbionTool {
	if (!isRecord(value)) throw new Error('Tools must be normalized Ambion tools.');
	if (
		typeof value.name !== 'string' ||
		typeof value.description !== 'string' ||
		typeof value.label !== 'string' ||
		!isToolSchema(value.parameters) ||
		typeof value.invoke !== 'function'
	) {
		throw new Error('Tools must be normalized Ambion tools.');
	}
	if (value.prepareArguments !== undefined && typeof value.prepareArguments !== 'function') {
		throw new Error('Tool prepareArguments must be a function.');
	}
	if (!isExecutionMode(value.executionMode)) {
		throw new Error('Tool executionMode must be sequential or parallel.');
	}
}

function assertDefineToolOptions(value: unknown): void {
	if (!isRecord(value)) throw new Error('Tool options must be an object.');
	if (
		typeof value.name !== 'string' ||
		value.name.length === 0 ||
		typeof value.description !== 'string' ||
		!isToolSchema(value.parameters) ||
		typeof value.execute !== 'function'
	) {
		throw new Error('Tool options are malformed.');
	}
	if (value.label !== undefined && typeof value.label !== 'string') {
		throw new Error('Tool label must be a string.');
	}
	if (value.prepareArguments !== undefined && typeof value.prepareArguments !== 'function') {
		throw new Error('Tool prepareArguments must be a function.');
	}
	if (!isExecutionMode(value.executionMode)) {
		throw new Error('Tool executionMode must be sequential or parallel.');
	}
}

function isToolSchema(value: unknown): value is TSchema {
	return typeof value === 'boolean' || IsSchema(value);
}

function isExecutionMode(value: unknown): value is ToolExecutionMode | undefined {
	return value === undefined || value === 'sequential' || value === 'parallel';
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === 'object' && value !== null;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Whether a value is a name the room can address. */
export function isName(value: unknown): value is string {
	return typeof value === 'string' && NAME_PATTERN.test(value);
}

function assertName(name: unknown): asserts name is string {
	if (!isName(name)) {
		throw new AmbionError(
			'invalid_name',
			`Invalid participant name '${name}': names are lowercase, alphanumeric plus dashes.`,
		);
	}
}

/** A room name follows the same rule as a participant name: lowercase, alphanumeric plus dashes. */
export function assertRoomName(name: unknown): asserts name is string {
	if (!isName(name)) {
		throw new AmbionError(
			'invalid_name',
			`Invalid room name '${name}': names are lowercase, alphanumeric plus dashes.`,
		);
	}
}
