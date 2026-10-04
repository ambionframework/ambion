/**
 * The catalog of the `compose` tool: one TypeScript signature for each tool
 * that code can bind, and the compact list of those tools. The renderer reads the JSON Schema that TypeBox
 * writes. A schema with no TypeScript form renders as `unknown`. A field
 * description becomes a doc comment, and a schema with an `$id` becomes a
 * named type. A schema whose `$id` is no identifier, or whose `$id` another
 * schema already holds, renders inline. The renderer never throws, because
 * it must not stop `defineAgent`. The input schema stays the authority, because `compose`
 * checks every argument against it (`docs/compose.md`). The `describe` tool
 * renders the signatures of the tools that a call names, and a failed compose
 * call renders the signatures of the tools that it names.
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

/** What one render collects: the named types, by id, with the schema each id came from. */
interface Catalog {
	readonly named: Map<string, { readonly key: string; text: string }>;
}

function literal(value: unknown): string {
	return ['string', 'number', 'boolean'].includes(typeof value) || value === null
		? JSON.stringify(value)
		: 'unknown';
}

function union(members: readonly unknown[], catalog: Catalog, indent: string): string {
	const forms = [...new Set(members.map((member) => typeOf(member, catalog, indent)))];
	return forms.includes('unknown') ? 'unknown' : forms.join(' | ');
}

/** The description of a field, when its doc comment belongs at the field. A named type keeps its own. */
function noteOf(schema: unknown): string | undefined {
	if (!isNode(schema)) return undefined;
	if (typeof schema.description !== 'string' || typeof schema.$id === 'string') return undefined;
	return schema.description.trim() === '' ? undefined : schema.description;
}

/** The description as a doc comment at `indent`. A comment end in the text is escaped. */
function docComment(description: string, indent: string): string {
	const lines = description
		.trim()
		.split('\n')
		.map((line) => line.trimEnd().replaceAll('*/', '*\\/'));
	if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
	return [
		`${indent}/**`,
		...lines.map((line) => (line === '' ? `${indent} *` : `${indent} * ${line}`)),
		`${indent} */`,
	].join('\n');
}

interface Field {
	readonly line: string;
	readonly note: string | undefined;
}

/** The fields on one line, or one to a line with their doc comments when any field has a note. */
function layout(fields: readonly Field[], indent: string): string {
	const multi = fields.some((field) => field.note !== undefined || field.line.includes('\n'));
	if (!multi) return `{ ${fields.map((field) => field.line).join('; ')} }`;
	const inner = `${indent}  `;
	const lines = fields.flatMap((field) => [
		...(field.note === undefined ? [] : [docComment(field.note, inner)]),
		`${inner}${field.line};`,
	]);
	return ['{', ...lines, `${indent}}`].join('\n');
}

function objectOf(node: Node, catalog: Catalog, indent: string): string {
	const properties = isNode(node.properties) ? node.properties : {};
	const required = Array.isArray(node.required) ? node.required : [];
	const fields = Object.entries(properties).map(([name, schema]) => ({
		line: `${keyOf(name)}${required.includes(name) ? '' : '?'}: ${typeOf(schema, catalog, `${indent}  `)}`,
		note: noteOf(schema),
	}));
	const pattern = isNode(node.patternProperties) ? Object.values(node.patternProperties)[0] : null;
	const rest = isNode(node.additionalProperties) ? node.additionalProperties : pattern;
	if (fields.length > 0) return layout(fields, indent);
	return rest === null || rest === undefined
		? '{}'
		: `Record<string, ${typeOf(rest, catalog, indent)}>`;
}

function arrayOf(node: Node, catalog: Catalog, indent: string): string {
	const items = node.items;
	if (!isNode(items)) return 'unknown[]';
	const text = typeOf(items, catalog, indent);
	const listed = typeof items.$id !== 'string' && alternatives(items) !== undefined;
	return `${listed && text.includes(' | ') ? `(${text})` : text}[]`;
}

/** The members of a schema that lists alternatives: an enum, a type list, or a union. */
function alternatives(schema: Node): readonly unknown[] | undefined {
	if (Array.isArray(schema.enum)) return schema.enum.map((value) => ({ const: value }));
	if (Array.isArray(schema.type)) return schema.type.map((type) => ({ type }));
	const members = schema.anyOf ?? schema.oneOf;
	return Array.isArray(members) ? members : undefined;
}

/** The form of a schema that names one type. */
function shapeOf(node: Node, catalog: Catalog, indent: string): string {
	if (node.type === 'object') return objectOf(node, catalog, indent);
	if (node.type === 'array') return arrayOf(node, catalog, indent);
	return PRIMITIVES[String(node.type)] ?? 'unknown';
}

/** The TypeScript form of a schema, with no regard for its `$id`. */
function formOf(schema: Node, catalog: Catalog, indent: string): string {
	if ('const' in schema) return literal(schema.const);
	const members = alternatives(schema);
	return members === undefined ? shapeOf(schema, catalog, indent) : union(members, catalog, indent);
}

/**
 * The name of a schema that carries an `$id`. The first use adds the
 * declaration to the catalog. A schema that is no identifier, and a second
 * different schema with an id in use, render inline.
 */
function nameOf(schema: Node, id: string, catalog: Catalog, indent: string): string {
	const { $id: _id, ...body } = schema;
	if (!IDENTIFIER.test(id)) return formOf(body, catalog, indent);
	const key = JSON.stringify(body);
	const known = catalog.named.get(id);
	if (known !== undefined) {
		return known.key === key ? id : formOf(body, catalog, indent);
	}
	const entry = { key, text: '' };
	catalog.named.set(id, entry);
	const note = noteOf(body);
	const lead = note === undefined ? '' : `${docComment(note, '')}\n`;
	entry.text = `${lead}type ${id} = ${formOf(body, catalog, '')};`;
	return id;
}

/** The TypeScript form of one JSON Schema, or `unknown`. */
function typeOf(schema: unknown, catalog: Catalog, indent: string): string {
	if (!isNode(schema)) return 'unknown';
	return typeof schema.$id === 'string'
		? nameOf(schema, schema.$id, catalog, indent)
		: formOf(schema, catalog, indent);
}

/** The signature of one tool: its input, and its declared output or `string`. */
function signature(tool: AmbionTool, catalog: Catalog): string {
	const output = tool.compose ? typeOf(tool.compose.output, catalog, '  ') : 'string';
	return [
		docComment(tool.description, '  '),
		`  ${keyOf(tool.name)}(args: ${typeOf(tool.parameters, catalog, '  ')}): Promise<${output}>;`,
	].join('\n');
}

/** Whether code can bind the tool: a tool with `compose: false` stays out. */
export const bindable = (tool: AmbionTool): boolean => tool.compose !== false;

/**
 * The name of the type that a tool binds to. A tool with no declared output
 * binds to `string`. A declared output gives its `$id` when that is an
 * identifier, and else its primitive or `array` form, or `object`.
 */
function outputName(tool: AmbionTool): string {
	const output = tool.compose ? tool.compose.output : undefined;
	if (output === undefined) return 'string';
	const node: Node = isNode(output) ? output : {};
	if (typeof node.$id === 'string' && IDENTIFIER.test(node.$id)) return node.$id;
	if (node.type === 'array') return 'array';
	return PRIMITIVES[String(node.type)] ?? 'object';
}

/**
 * The compact list of the tools that code can bind with a typed result:
 * `name -> Type` for each, in the order given. A tool that returns text has no
 * entry. The list holds no signature. `renderCatalog` gives those.
 */
export function renderBindings(tools: readonly AmbionTool[]): string {
	return tools
		.filter(bindable)
		.map((tool) => [keyOf(tool.name), outputName(tool)] as const)
		.filter(([, type]) => type !== 'string')
		.map(([name, type]) => `${name} -> ${type}`)
		.join(', ');
}

/**
 * The catalog of the tools that code can bind, as TypeScript declarations.
 * A schema with an `$id` renders once as a `type` before the tools.
 */
export function renderCatalog(tools: readonly AmbionTool[]): string {
	const catalog: Catalog = { named: new Map() };
	const entries = tools.filter(bindable).map((tool) => signature(tool, catalog));
	const types = [...catalog.named.values()].map((entry) => entry.text);
	return [...types, 'declare const tools: {', ...entries, '};'].join('\n');
}
