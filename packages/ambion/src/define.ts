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
import type {
	AmbionTool,
	DeclaredToolOptions,
	PlainToolOptions,
	Reminder,
	ToolBundle,
	ToolConcurrency,
	ToolContext,
	ToolResult,
} from './bundle.ts';
import {
	assertComposeOptions,
	assertToolCompose,
	COMPOSE_TOOL_NAME,
	type ComposeOptions,
	DESCRIBE_TOOL_NAME,
	mismatchOf,
} from './compose.ts';
import { assertMacros, macrosOf } from './compose-macros.ts';
import { composeGuidance, composeTools } from './compose-tool.ts';
import { AmbionError } from './errors.ts';
import type { AgentDefinition, Executor, PersonDefinition, TracePolicy } from './types.ts';

export interface DefineAgentOptions {
	/** Identifies the agent inside a room and on the record. */
	name: string;
	/** The agent's public face — injected into every participant's context as part of the roster. */
	identity: string;
	/** The executor this agent runs on. Build one with the executor package, such as `pi()`. */
	executor: Executor;
	/** What the trace keeps of this agent's work. Absent keeps `DEFAULT_TRACE_POLICY`. */
	trace?: TracePolicy;
}

/** The default trace policy: full tool output, and the start of each thinking block. */
export const DEFAULT_TRACE_POLICY: TracePolicy = Object.freeze({
	thinking: 'start',
	toolOutput: 'full',
});

const THINKING = new Set(['omit', 'start', 'full']);
const TOOL_OUTPUT = new Set(['omit', 'full']);

/** A policy checked and copied. Absent gives the default. */
function capturePolicy(agent: string, policy: TracePolicy | undefined): TracePolicy {
	if (policy === undefined) return DEFAULT_TRACE_POLICY;
	if (!THINKING.has(policy.thinking))
		throw new Error(`Agent '${agent}' trace.thinking must be omit, start, or full.`);
	if (!TOOL_OUTPUT.has(policy.toolOutput))
		throw new Error(`Agent '${agent}' trace.toolOutput must be omit or full.`);
	return Object.freeze({ thinking: policy.thinking, toolOutput: policy.toolOutput });
}

/** The neutral half of an executor, as an executor kind's own options declare it. */
export interface ExecutorBaseOptions {
	/** The private half: the agent's own voice, and the home of all judgment. */
	readonly instructions: string;
	/** The agent's own normalized tools. */
	readonly tools?: readonly AmbionTool[];
	/** Composable tool bundles with guidance. Bundles are flattened at definition time. */
	readonly bundles?: readonly ToolBundle[];
	/** The speaking policy. It replaces `DEFAULT_SPEAKING`. Absent uses the default. */
	readonly speaking?: string;
	/** The token limit for the record one activation reads. Absent reads the whole record. */
	readonly activationTokenLimit?: number;
	/**
	 * The name of the estimator that counts tokens against the limit, from the
	 * registry of the runtime. Absent names `length`.
	 */
	readonly estimateTokens?: string;
	/**
	 * The `compose` tool for this seat. It joins the tools of the seat into
	 * one call, and the `describe` tool that returns the signatures of the
	 * tools it binds. The executor packages give a default when the field is
	 * absent. `describeExecutor` by itself adds no tool for an absent field.
	 */
	readonly compose?: ComposeOptions;
}

/** What `describeExecutor` reads: the fields every executor kind shares. */
export interface ExecutorOptions extends ExecutorBaseOptions {
	readonly kind: string;
}

/**
 * The executor a definition names, narrowed to one kind and its model.
 * Throws when the executor's kind does not match.
 */
export function executorOfKind<T extends Executor & { readonly model: string }>(
	executor: Executor,
	kind: T['kind'],
): T {
	if (executor.kind === kind && 'model' in executor && typeof executor.model === 'string') {
		return executor as T;
	}
	throw new Error(`Cannot run an executor of kind '${executor.kind}': this seat needs '${kind}'.`);
}

/** The entries of `fields` that hold a value. */
export function present<T extends object>(fields: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	) as Partial<T>;
}

/** The fields of `options` that `keys` name and that hold a value. */
export function pickPresent<T extends object, K extends keyof T>(
	options: T,
	keys: readonly K[],
): Partial<Pick<T, K>> {
	return present(Object.fromEntries(keys.map((key) => [key, options[key]]))) as Partial<Pick<T, K>>;
}

/**
 * The neutral half of an executor: validated, flattened, and frozen. An
 * executor kind adds its own fields to the value this returns.
 */
export function describeExecutor(options: ExecutorOptions): Executor {
	assertComposeOptions(options.compose);
	const compose = options.compose;
	const input = flattenTools(options.tools, options.bundles);
	// A seat without `compose` ignores the macros, so one skill set fits every seat.
	const macros = compose === undefined ? [] : macrosOf(options.bundles);
	assertMacros(macros, input);
	const own = input.map((tool) => captureTool(tool));
	const guidance = joined([guidanceOf(options.bundles), composeGuidance(compose, own, macros)]);
	const reminders = remindersOf(options.bundles);
	// The `compose` tool closes over the option and the tools above. The executor keeps no field of it.
	const tools = Object.freeze(
		compose === undefined
			? own
			: [...own, ...composeTools(compose, own, macros, ROOM_COMPOSE).map(captureTool)],
	);
	return Object.freeze({
		kind: options.kind,
		instructions: options.instructions,
		tools,
		...(guidance === undefined ? {} : { guidance }),
		...(reminders === undefined ? {} : { reminders }),
		...(options.speaking === undefined ? {} : { speaking: options.speaking }),
		...recordLimit(options.activationTokenLimit, options.estimateTokens),
	});
}

/** Define an agent. The room captures the definition the same way, so both check and copy alike. */
export function defineAgent(options: DefineAgentOptions): AgentDefinition {
	return captureAgent(options);
}

/** The record-window fields, validated and written only when a limit is set. */
function recordLimit(
	activationTokenLimit: number | undefined,
	estimateTokens: string | undefined,
): { activationTokenLimit?: number; estimateTokens?: string } {
	if (activationTokenLimit === undefined) {
		if (estimateTokens !== undefined)
			throw new Error('An agent estimateTokens needs an activationTokenLimit.');
		return {};
	}
	if (!Number.isSafeInteger(activationTokenLimit) || activationTokenLimit <= 0)
		throw new Error('An agent activationTokenLimit must be a positive integer.');
	if (estimateTokens !== undefined && (typeof estimateTokens !== 'string' || estimateTokens === ''))
		throw new Error('An agent estimateTokens must be the name of an estimator.');
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
		trace: capturePolicy(agent.name, agent.trace),
	});
}

/**
 * Capture one executor at a room boundary. The copy is deep, so a field an
 * executor kind adds, such as a model, survives without a name here.
 */
function captureExecutor(executor: Executor): Executor {
	const tools = Object.freeze(
		executor.tools.map((tool) => {
			assertTool(tool);
			return captureTool(tool);
		}),
	);
	recordLimit(executor.activationTokenLimit, executor.estimateTokens);
	assertReminders(executor.reminders);
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

/** Define a person. The room captures the definition the same way, so both check and trim alike. */
export function definePerson(options: DefineHumanOptions): PersonDefinition {
	return captureHuman(options);
}

/** Capture a person at a room boundary. Blank preferences are no preferences. */
export function captureHuman(human: PersonDefinition): PersonDefinition {
	assertName(human.name);
	const preferences = human.preferences?.trim() || undefined;
	return Object.freeze({
		name: human.name,
		identity: human.identity,
		...(preferences === undefined ? {} : { preferences }),
	});
}

/**
 * Define one typed tool. The callback receives parsed parameters and the
 * calling agent context. A native Pi tool goes through `fromPiTool`, from
 * `@ambionframework/pi`.
 */
export function defineTool<TParameters extends TSchema>(
	options: PlainToolOptions<TParameters>,
): AmbionTool;
/** Define one typed tool that declares its output. The compiler checks `details` against it. */
export function defineTool<
	TParameters extends TSchema,
	TOutput extends TSchema,
	const TDetails extends Static<TOutput>,
>(options: DeclaredToolOptions<TParameters, TOutput, TDetails>): AmbionTool;
export function defineTool<TParameters extends TSchema>(
	options: PlainToolOptions<TParameters> | DeclaredToolOptions<TParameters, TSchema>,
): AmbionTool {
	assertDefineToolOptions(options);
	const parameters = capture(options.parameters);
	const name = options.name;
	const execute: (
		params: Static<TParameters>,
		ctx: ToolContext,
	) => Promise<string | ToolResult> | string | ToolResult = options.execute;
	return Object.freeze({
		name,
		description: options.description,
		parameters,
		label: options.label ?? name,
		...(options.prepareArguments === undefined
			? {}
			: { prepareArguments: options.prepareArguments }),
		...(options.executionMode === undefined ? {} : { executionMode: options.executionMode }),
		...captureCompose(options.compose),
		invoke: (params: unknown, context: ToolContext) => {
			if (!Check(parameters, params)) {
				throw new Error(`Invalid arguments for tool '${name}': ${mismatchOf(parameters, params)}.`);
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

/**
 * The refs a message cites. Each item names the ref forms a model makes: a
 * workspace path and a table have no ref form. `say` holds the rule in full,
 * and `schedule` points to it.
 */
const cited = (description: string) => Type.Array(Type.String({ description }));
const SAY_REFS = cited(
	'An absolute URI the message cites. Cite a file by the ref that `snapshot` gives, never by its path, a commit by its commit ref, and a message by ambion://room/<room>/message/<seq>.',
);
const SCHEDULE_REFS = cited('An absolute URI the message cites, in the forms that `say` takes.');

/** The room tool that every activation may use to speak. */
export const SAY = {
	name: 'say' as const,
	description:
		'Speak on the record. Omit `to` to address the room; set `to` to address a participant directly.',
	parameters: Type.Object({
		to: Type.Optional(Type.String({ description: 'A participant name from the roster.' })),
		text: Type.String({ description: 'What you say, as the record shows it.' }),
		refs: Type.Optional(SAY_REFS),
	}),
};

/** The room tool that seats one supplied agent. */
export const SEAT = {
	name: 'seat' as const,
	description: 'Seat one agent from the reserve. It joins the room and reads the record.',
	parameters: Type.Object({
		name: Type.String({ description: 'An agent name from the reserve.' }),
	}),
};

/** The room tool that removes one seated agent. */
export const UNSEAT = {
	name: 'unseat' as const,
	description:
		"Remove one seated agent from the room. A fixed seat, such as the summary writer's, stays.",
	parameters: Type.Object({
		name: Type.String({ description: 'A seated agent name.' }),
	}),
};

/** The room tool that dismisses one scheduled say of the seat. */
export const DISMISS = {
	name: 'dismiss' as const,
	description: 'Drop a message you scheduled, by its seq. The room does not wake you with it.',
	parameters: Type.Object({
		message: Type.Integer({
			minimum: 1,
			description: 'The seq of the scheduled message, as the record shows it: 41 for #41.',
		}),
	}),
};

/** The room tool that schedules a say to the seat itself, to come back to its work later. */
export const SCHEDULE = {
	name: 'schedule' as const,
	description:
		'Schedule a message to yourself. After `delaySeconds` seconds, the room wakes you with this text. The message then opens an exchange for the person of the exchange in which you scheduled it. The result names the seq of the message; `dismiss` drops it.',
	parameters: Type.Object({
		delaySeconds: Type.Integer({
			minimum: 1,
			description: 'Seconds until the room wakes you with this message.',
		}),
		text: Type.String({ description: 'What to do when the room wakes you.' }),
		refs: Type.Optional(SCHEDULE_REFS),
	}),
};

/** The room tool that reads messages of the room by URI. It commits nothing. */
export const RECALL = {
	name: 'recall' as const,
	description:
		'Read messages of this room by seq, as #12, or by URI, ambion://room/<room>/message/<seq>: a message that your context leaves out or that a summary folds, or one that a say cites. The result gives one line for each ref.',
	parameters: Type.Object({
		refs: Type.Array(
			Type.String({ description: 'A message of this room: its seq as #12, or its URI.' }),
			{
				minItems: 1,
				// The count of refs one message carries: `REF_LIMITS.count`.
				maxItems: 16,
			},
		),
	}),
};

/** The names that the room supplies for an activation. An agent's own tool takes none of them. */
export const ROOM_TOOL_NAMES: readonly string[] = [
	SAY.name,
	SCHEDULE.name,
	RECALL.name,
	SEAT.name,
	UNSEAT.name,
	DISMISS.name,
];

/** The room tools that a compose call binds. The catalog lists them for every seat that composes. */
const ROOM_COMPOSE = [
	SAY,
	SCHEDULE,
	RECALL,
	// The room offers `seat` and `unseat` to some rooms alone, so the catalog lists them apart.
	{ ...SEAT, optional: true as const },
	{ ...UNSEAT, optional: true as const },
	DISMISS,
];

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
		if (tool.name === COMPOSE_TOOL_NAME || tool.name === DESCRIBE_TOOL_NAME)
			throw new AmbionError(
				'invalid_tool',
				`A tool of the agent ${source} is named '${tool.name}': the compose option reserves the name. Give the tool another name.`,
			);
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
		...captureCompose(tool.compose),
		invoke: tool.invoke,
	});
}

/** The `compose` field of a tool, copied. The `output` schema is captured as `parameters` is. */
function captureCompose(compose: AmbionTool['compose']): Pick<AmbionTool, 'compose'> {
	if (compose === undefined || compose === false) return compose === undefined ? {} : { compose };
	return { compose: Object.freeze({ output: capture(compose.output) }) };
}

/** The reminder of each bundle that has one, in bundle order, or undefined for none. */
function remindersOf(bundles: readonly ToolBundle[] | undefined): readonly Reminder[] | undefined {
	const reminders = (bundles ?? []).flatMap((bundle) =>
		bundle.remind === undefined ? [] : [bundle.remind],
	);
	assertReminders(reminders);
	return reminders.length === 0 ? undefined : Object.freeze(reminders);
}

function assertReminders(reminders: readonly unknown[] | undefined): void {
	if (reminders === undefined) return;
	if (!Array.isArray(reminders) || reminders.some((one) => typeof one !== 'function')) {
		throw new Error('A bundle remind must be a function.');
	}
}

/** The guidance texts that exist, joined by a blank line, or undefined for none. */
function joined(texts: readonly (string | undefined)[]): string | undefined {
	return texts.filter((text): text is string => text !== undefined).join('\n\n') || undefined;
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
		const roomTool = ROOM_TOOL_NAMES.includes(name);
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
	assertToolCompose(value.compose);
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
	assertToolCompose(value.compose);
}

function isToolSchema(value: unknown): value is TSchema {
	return typeof value === 'boolean' || IsSchema(value);
}

function isExecutionMode(value: unknown): value is ToolConcurrency | undefined {
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
