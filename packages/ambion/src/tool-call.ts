/**
 * The steps of a tool call. `checkedArguments` prepares the arguments and
 * checks them against the schema of the tool. `mismatchOf` says what a
 * schema refuses. `callChecked` calls `invoke`
 * and records the two steps of a nested call of `compose`
 * (`docs/compose.md`). The functions hold no state and read no room.
 */
import type { TSchema } from 'typebox';
import { Check, Errors } from 'typebox/value';
import type { AmbionTool, ToolContext, ToolResult } from './bundle.ts';
import type { Step } from './types.ts';

/** A nested call: the id of the call that made it, and where its steps go. */
export interface ToolCallNest {
	/** The call id of the call that made this call. The two steps carry it as `parent`. */
	readonly parent: string;
	readonly record: (step: Step) => void;
}

/**
 * What the arguments of a call break in a schema, as the model reads it:
 * each property path and its rule, such as `processes must not have fewer
 * than 1 items`. A rule on the whole value has no path.
 */
export function mismatchOf(schema: TSchema, value: unknown): string {
	return Errors(schema, value)
		.map((error) => {
			const path = error.instancePath.slice(1).replaceAll('/', '.');
			return path === '' ? error.message : `${path} ${error.message}`;
		})
		.join('; ');
}

/** The message of a thrown value. */
export function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'object' && error !== null && 'message' in error)
		return String(error.message);
	return String(error);
}

/**
 * The arguments of a call, prepared and checked: `prepareArguments` first,
 * then the schema of the tool. A tool built by hand can have an `invoke` that
 * checks nothing, so this check stands for every tool.
 */
export function checkedArguments(tool: AmbionTool, args: unknown): unknown {
	const params = tool.prepareArguments === undefined ? args : tool.prepareArguments(args);
	if (!Check(tool.parameters, params))
		throw new Error(
			`Invalid arguments for tool '${tool.name}': ${mismatchOf(tool.parameters, params)}.`,
		);
	return params;
}

/** The result of a tool, in the shape that the trace keeps. */
function outputOf(result: string | ToolResult): unknown {
	if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
	return {
		content: result.content,
		...(result.details === undefined ? {} : { details: result.details }),
	};
}

/**
 * Call `invoke` with arguments that `checkedArguments` already returned.
 * `args` are the arguments as the caller gave them, and the `tool_call` step
 * keeps them. A nested call records its `tool_call` step before `invoke` and
 * its `tool_result` step after it, an error step when `invoke` throws. The
 * error then reaches the caller as it was.
 */
export async function callChecked(
	tool: AmbionTool,
	args: unknown,
	params: unknown,
	ctx: ToolContext,
	nest?: ToolCallNest,
): Promise<string | ToolResult> {
	nest?.record({
		type: 'tool_call',
		call: ctx.callId,
		name: tool.name,
		input: args,
		parent: nest.parent,
	});
	let result: string | ToolResult;
	try {
		result = await tool.invoke(params, ctx);
	} catch (error) {
		const message = messageOf(error);
		nest?.record({
			type: 'tool_result',
			call: ctx.callId,
			output: { content: [{ type: 'text', text: message }] },
			error: message,
			parent: nest.parent,
		});
		throw error;
	}
	nest?.record({
		type: 'tool_result',
		call: ctx.callId,
		output: outputOf(result),
		parent: nest.parent,
	});
	return result;
}
