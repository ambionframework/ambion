/**
 * The catalog of the `compose` tool: one TypeScript signature for each tool
 * that code can bind. The renderer reads the JSON Schema that TypeBox
 * writes. A schema with no TypeScript form renders as `unknown`. The input
 * schema stays the authority, because `compose` checks every argument
 * against it (`docs/compose.md`).
 */
import type { AmbionTool } from './bundle.ts';

type Node = Readonly<Record<string, unknown>>;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const isNode = (value: unknown): value is Node =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** A property name, quoted when it is not an identifier. */
const keyOf = (name: string): string => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

const PRIMITIVES: Readonly<Record<string, string>> = {
	string: 'string',
	number: 'number',
	integer: 'number',
	boolean: 'boolean',
	null: 'null',
};

/** A union member, in the place where a union needs parentheses. */
const wrapped = (text: string): string => (text.includes(' | ') ? `(${text})` : text);

function literal(value: unknown): string {
	return ['string', 'number', 'boolean'].includes(typeof value) || value === null
		? JSON.stringify(value)
		: 'unknown';
}

function union(members: readonly unknown[]): string {
	const forms = [...new Set(members.map((member) => typeOf(member)))];
	return forms.includes('unknown') ? 'unknown' : forms.join(' | ');
}

function objectOf(node: Node): string {
	const properties = isNode(node.properties) ? node.properties : {};
	const required = Array.isArray(node.required) ? node.required : [];
	const fields = Object.entries(properties).map(
		([name, schema]) => `${keyOf(name)}${required.includes(name) ? '' : '?'}: ${typeOf(schema)}`,
	);
	const pattern = isNode(node.patternProperties) ? Object.values(node.patternProperties)[0] : null;
	const rest = isNode(node.additionalProperties) ? node.additionalProperties : pattern;
	if (fields.length === 0 && rest !== null && rest !== undefined)
		return `Record<string, ${typeOf(rest)}>`;
	return fields.length === 0 ? '{}' : `{ ${fields.join('; ')} }`;
}

function arrayOf(node: Node): string {
	return isNode(node.items) ? `${wrapped(typeOf(node.items))}[]` : 'unknown[]';
}

/** The members of a schema that lists alternatives: an enum, a type list, or a union. */
function alternatives(schema: Node): readonly unknown[] | undefined {
	if (Array.isArray(schema.enum)) return schema.enum.map((value) => ({ const: value }));
	if (Array.isArray(schema.type)) return schema.type.map((type) => ({ type }));
	const members = schema.anyOf ?? schema.oneOf;
	return Array.isArray(members) ? members : undefined;
}

/** The form of a schema that names one type. */
function shapeOf(node: Node): string {
	if (node.type === 'object') return objectOf(node);
	if (node.type === 'array') return arrayOf(node);
	return PRIMITIVES[String(node.type)] ?? 'unknown';
}

/** The TypeScript form of one JSON Schema, or `unknown`. */
function typeOf(schema: unknown): string {
	if (!isNode(schema)) return 'unknown';
	if ('const' in schema) return literal(schema.const);
	const members = alternatives(schema);
	return members === undefined ? shapeOf(schema) : union(members);
}

/** The description as a doc comment. A comment end in the text is escaped. */
function docComment(description: string): string {
	const lines = description
		.trim()
		.split('\n')
		.map((line) => line.trimEnd().replaceAll('*/', '*\\/'));
	if (lines.length === 1) return `  /** ${lines[0]} */`;
	return ['  /**', ...lines.map((line) => (line === '' ? '   *' : `   * ${line}`)), '   */'].join(
		'\n',
	);
}

/** The signature of one tool: its input, and its declared output or `string`. */
function signature(tool: AmbionTool): string {
	const output = tool.compose ? typeOf(tool.compose.output) : 'string';
	return [
		docComment(tool.description),
		`  ${keyOf(tool.name)}(args: ${typeOf(tool.parameters)}): Promise<${output}>;`,
	].join('\n');
}

/** Whether code can bind the tool: a tool with `compose: false` stays out. */
export const bindable = (tool: AmbionTool): boolean => tool.compose !== false;

/** The catalog of the tools that code can bind, as TypeScript declarations. */
export function renderCatalog(tools: readonly AmbionTool[]): string {
	const entries = tools.filter(bindable).map(signature);
	return ['declare const tools: {', ...entries, '};'].join('\n');
}
