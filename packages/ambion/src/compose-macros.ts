/**
 * The macros of a seat: the check of one macro, the check of the macros of
 * a definition against its tools, and the lines that the `compose` guidance
 * shows (`docs/compose.md`). A macro is data that a bundle carries. A skill
 * set makes it (`docs/skills.md`), and `compose` runs it by name.
 */
import { Meta } from 'typebox/schema';
import { Check, Errors } from 'typebox/value';
import type { ToolBundle } from './bundle.ts';
import { type ComposeMacro, plainJson } from './compose.ts';
import { AmbionError } from './errors.ts';

const METASCHEMA = Meta['https://json-schema.org/draft/2020-12/schema'];

/** The keywords whose value is data: `Check` reads each one, or the keyword only describes. */
const DATA_KEYWORDS = new Set([
	'type',
	'required',
	'enum',
	'const',
	'minimum',
	'maximum',
	'exclusiveMinimum',
	'exclusiveMaximum',
	'multipleOf',
	'minLength',
	'maxLength',
	'pattern',
	'minItems',
	'maxItems',
	'uniqueItems',
	'minProperties',
	'maxProperties',
	'minContains',
	'maxContains',
	'dependentRequired',
	'title',
	'description',
	'default',
	'examples',
	'$comment',
]);

/** The keywords whose value is one schema. */
const SCHEMA_KEYWORDS = new Set([
	'additionalProperties',
	'items',
	'not',
	'contains',
	'propertyNames',
	'if',
	'then',
	'else',
	'unevaluatedItems',
	'unevaluatedProperties',
]);

/** The keywords whose value is a list of schemas. */
const LIST_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

/** The keywords whose value maps names to schemas. */
const MAP_KEYWORDS = new Set(['properties', 'patternProperties', 'dependentSchemas']);

/** Every keyword that a macro schema may hold. */
const KEYWORDS = new Set([...DATA_KEYWORDS, ...SCHEMA_KEYWORDS, ...LIST_KEYWORDS, ...MAP_KEYWORDS]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The sub-schemas that the keyword `key` holds, each with its path. */
function children(key: string, value: unknown, at: string): [string, unknown][] {
	if (SCHEMA_KEYWORDS.has(key)) return [[at, value]];
	if (LIST_KEYWORDS.has(key) && Array.isArray(value))
		return value.map((item, index): [string, unknown] => [`${at}[${index}]`, item]);
	if (MAP_KEYWORDS.has(key) && isRecord(value))
		return Object.entries(value).map(([name, item]) => [`${at}.${name}`, item]);
	return [];
}

/**
 * The first keyword that `Check` does not read, with its path. `Check`
 * ignores a keyword that it does not know, so a schema that holds one would
 * pass every value. A reference, a format, and an identifier are among
 * them.
 */
function unsupported(schema: unknown, path: string): string | undefined {
	if (!isRecord(schema)) return undefined;
	for (const [key, value] of Object.entries(schema)) {
		const found = unsupportedIn(key, value, path);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The first unsupported keyword at `key` of the schema at `path`, or inside its sub-schemas. */
function unsupportedIn(key: string, value: unknown, path: string): string | undefined {
	const at = path === '' ? key : `${path}.${key}`;
	if (!KEYWORDS.has(key))
		return `the keyword '${key}' at ${path === '' ? 'the top' : path}, which the check does not read`;
	return children(key, value, at)
		.map(([place, child]) => unsupported(child, place))
		.find((found) => found !== undefined);
}

/**
 * Why `schema` cannot check arguments, or undefined when it can: it is not
 * a JSON Schema of draft 2020-12, or it holds a keyword that `Check` does
 * not read.
 */
function schemaFault(schema: unknown): string | undefined {
	if (!isRecord(schema)) return 'args must be a JSON Schema object';
	if (!Check(METASCHEMA, schema)) {
		const [error] = Errors(METASCHEMA, schema);
		const where = error?.instancePath.slice(1).replaceAll('/', '.') ?? '';
		return `args is not a JSON Schema: ${where === '' ? '' : `${where} `}${error?.message ?? 'it is invalid'}`;
	}
	const found = unsupported(schema, '');
	return found === undefined ? undefined : `args holds ${found}`;
}

/** The text fields of `value`, refused when one is blank. */
function textFault(value: MacroFields): string | undefined {
	for (const field of ['name', 'description', 'code', 'hash'] as const) {
		const text = value[field];
		if (typeof text !== 'string' || (field !== 'code' && text.trim() === ''))
			return `${field} must be ${field === 'code' ? 'text' : 'text that is not blank'}`;
	}
	return undefined;
}

/** Why the `uses` of a macro is not a non-empty list of tool names, or undefined. */
function usesFault(uses: unknown): string | undefined {
	if (
		!Array.isArray(uses) ||
		uses.length === 0 ||
		uses.some((name) => typeof name !== 'string' || name.trim() === '')
	)
		return 'uses must be a non-empty list of tool names';
	return undefined;
}

/** The fields of a macro as a caller read them, before the check. */
export type MacroFields = { readonly [K in keyof ComposeMacro]: unknown };

/**
 * Check one macro and give a frozen copy of it. The error message names the
 * first fault and not the macro, so a caller can add its own place.
 */
export function composeMacro(fields: MacroFields): ComposeMacro {
	const fault = textFault(fields) ?? usesFault(fields.uses) ?? schemaFault(fields.args);
	if (fault !== undefined) throw new Error(fault);
	return deepFrozen({
		name: String(fields.name),
		description: String(fields.description),
		uses: (fields.uses as readonly string[]).map(String),
		args: plainJson(fields.args, 'args') as ComposeMacro['args'],
		code: String(fields.code),
		hash: String(fields.hash),
	});
}

function deepFrozen<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		for (const item of Object.values(value)) deepFrozen(item);
		Object.freeze(value);
	}
	return value;
}

/** The macros of every bundle, checked and copied, in bundle order. */
export function macrosOf(bundles: readonly ToolBundle[] | undefined): readonly ComposeMacro[] {
	return (bundles ?? []).flatMap((bundle) => {
		if (bundle.macros === undefined) return [];
		if (!Array.isArray(bundle.macros))
			throw new AmbionError('invalid_tool', 'A bundle macros must be an array.');
		return bundle.macros.map((macro) => checked(macro));
	});
}

function checked(macro: unknown): ComposeMacro {
	if (!isRecord(macro)) throw new AmbionError('invalid_tool', 'A bundle macro must be an object.');
	try {
		return composeMacro(macro as MacroFields);
	} catch (error) {
		const name = typeof macro.name === 'string' ? ` '${macro.name}'` : '';
		throw new AmbionError(
			'invalid_tool',
			`The macro${name} is not valid: ${(error as Error).message}.`,
		);
	}
}

/**
 * Refuse a macro that names a tool that `catalog` does not hold, and two
 * macros of one name. `catalog` holds the names of the tools that a compose
 * call binds: the room tools and the tools of the definition. A tool with
 * `compose: false`, the tool `compose`, and the tool `describe` are not in it.
 */
export function assertMacros(macros: readonly ComposeMacro[], catalog: ReadonlySet<string>): void {
	const seen = new Set<string>();
	for (const macro of macros) {
		if (seen.has(macro.name))
			throw new AmbionError('invalid_tool', `Two macros are named '${macro.name}'.`);
		seen.add(macro.name);
		const missing = macro.uses.filter((name) => !catalog.has(name));
		if (missing.length > 0)
			throw new AmbionError(
				'invalid_tool',
				`The macro '${macro.name}' uses ${missing.map((name) => `'${name}'`).join(', ')}, which the compose catalog does not hold.`,
			);
	}
}

/** The guidance lines of the macros: one line for each, with the name and the description. */
export function macroGuidance(macros: readonly ComposeMacro[]): string | undefined {
	if (macros.length === 0) return undefined;
	const lines = macros.map(
		(macro) => `- ${macro.name}: ${macro.description.trim().replace(/\s+/g, ' ')}`,
	);
	return [
		'The macros of your skills. When a skill names one, run it with compose({ macro, args }) and write no code. The macro holds the code and names its own tools:',
		...lines,
	].join('\n');
}
