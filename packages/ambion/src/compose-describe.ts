/**
 * The disclosure of the `compose` catalog. The description of `compose`
 * holds a compact list of the bindable tools, and this file builds it. The
 * `describe` tool renders the signatures and the named types of the tools
 * that a call names, and runs nothing. A failed compose call appends the
 * signatures of the tools that it names (`docs/compose.md`).
 */
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import type { AmbionTool } from './bundle.ts';
import { type ComposeResult, DESCRIBE_TOOL_NAME, mismatchOf } from './compose.ts';
import { renderBindings, renderCatalog } from './compose-catalog.ts';

type Catalog = ReadonlyMap<string, AmbionTool>;

/**
 * What the description of `compose` says about the tools that code binds.
 * The `optional` tools are the room tools that some activations lack: the
 * text lists them apart, so the catalog claims no tool that the seat may
 * not hold.
 */
export function bindingsText(catalog: Catalog, optional: ReadonlySet<string> = new Set()): string {
	const tools = [...catalog.values()];
	const some = tools.filter((tool) => optional.has(tool.name)).map((tool) => tool.name);
	const typed = renderBindings(tools.filter((tool) => !optional.has(tool.name)));
	const held =
		typed === ''
			? 'Every tool that code can bind returns text.'
			: `Tools that code can bind, each with the type of its result: ${typed}. The other tools return text.`;
	return some.length === 0
		? held
		: `${held} ${some.join(' and ')} bind only when your tool list holds them.`;
}

const ARGUMENTS = Type.Object({
	tools: Type.Array(Type.String(), {
		minItems: 1,
		description: 'The names of the tools to describe, such as ["sql", "snapshot"].',
	}),
});

/** The tools that `names` give, in order. A name outside the catalog throws an error that lists the bindable names. */
function tools(names: readonly string[], catalog: Catalog): AmbionTool[] {
	const missing = names.filter((name) => !catalog.has(name));
	if (missing.length > 0)
		throw new Error(
			`The catalog holds no tool named ${missing.map((name) => `'${name}'`).join(', ')}. The bindable tools are ${[...catalog.keys()].join(', ')}.`,
		);
	return names.flatMap((name) => catalog.get(name) ?? []);
}

/**
 * The `describe` tool over the catalog of a `compose` tool. It is an ordinary
 * tool: it reads the catalog, calls no tool, and has no effect. The catalog
 * is fixed when the definition is made, so the tool list never varies.
 */
export function describeTool(catalog: Catalog): AmbionTool {
	return Object.freeze({
		name: DESCRIBE_TOOL_NAME,
		description:
			'Return the typed signatures and the named types of tools that compose can bind. It runs nothing. Call it before you write compose code that reads the fields of the result of a tool.',
		parameters: ARGUMENTS,
		label: DESCRIBE_TOOL_NAME,
		compose: false,
		invoke: (params: unknown) => {
			if (!Check(ARGUMENTS, params))
				throw new Error(
					`Invalid arguments for tool '${DESCRIBE_TOOL_NAME}': ${mismatchOf(ARGUMENTS, params)}.`,
				);
			return renderCatalog(tools([...new Set(params.tools)], catalog));
		},
	});
}

/** The pattern of the message that a runtime gives for a tool that the seat has and the call did not bind. */
const UNBOUND = /\btools\.([\w$-]+) is not bound\./;

/**
 * The tools of the catalog that a failed result names: the tool of the call
 * that failed, and the tool that the code read and `uses` left out.
 */
export function namedTools(result: ComposeResult, catalog: Catalog): readonly AmbionTool[] {
	const failing = result.calls.find((call) => call.call === result.error?.call)?.tool;
	const unbound = UNBOUND.exec(result.error?.message ?? '')?.[1];
	return [...new Set([failing, unbound])].flatMap((name) => {
		const tool = name === undefined ? undefined : catalog.get(name);
		return tool === undefined ? [] : [tool];
	});
}

/** The lines that give the signatures of the tools that a failure names, so the model can correct its code. */
export function signatureText(named: readonly AmbionTool[]): string[] {
	return named.length === 0
		? []
		: ['Signatures of the tools that the failure names:', renderCatalog(named)];
}
