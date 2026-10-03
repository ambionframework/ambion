/**
 * The macros of a seat: the check of one macro, the check of a definition
 * that carries macros, the guidance lines, and a compose call that runs a
 * macro by name. The code runs in the runtime of `test/support`.
 */
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import type { ToolBundle } from '../src/bundle.ts';
import { ComposeFailure } from '../src/compose.ts';
import { describeExecutor } from '../src/define.ts';
import { invokeTool } from '../src/hosting.ts';
import {
	AmbionError,
	COMPOSE_GUIDANCE,
	type ComposeMacro,
	type ComposeRequest,
	type ComposeResult,
	composeMacro,
	defineTool,
} from '../src/index.ts';
import { functionRuntime } from './support/compose-runtime.ts';
import { echo, table, total } from './support/compose-tools.ts';

const hidden = defineTool({
	name: 'hidden',
	description: 'Stays out of compose.',
	parameters: Type.Object({}),
	compose: false,
	execute: () => 'hidden',
});

const LABEL_ARGS = {
	type: 'object',
	properties: { label: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1 } },
	required: ['label'],
	additionalProperties: false,
};

/** A macro of `name` over `uses`, with the label schema and code that echoes its arguments. */
function macro(name: string, uses: string[] = ['echo'], fields: Partial<ComposeMacro> = {}) {
	return composeMacro({
		name,
		description: `Echo the label.\nSecond line of ${name}.`,
		uses,
		args: LABEL_ARGS,
		code: "return await tools.echo({ text: args.label + ':' + (args.count ?? 1) });",
		hash: `hash-of-${name}`,
		...fields,
	});
}

const carrying = (...macros: ComposeMacro[]): ToolBundle => ({
	tools: [echo, table, total, hidden],
	macros,
});

/** The compose tool of a seat that holds `bundle`, with the options of the test. */
function seatOf(
	bundle: ToolBundle,
	approve?: (request: ComposeRequest) => 'allow' | 'deny',
	runtime = functionRuntime,
) {
	const executor = describeExecutor({
		kind: 'test',
		instructions: 'Test.',
		bundles: [bundle],
		compose: { runtime, ...(approve === undefined ? {} : { approve }) },
	});
	const tool = executor.tools.find((one) => one.name === 'compose');
	if (tool === undefined) throw new Error('The executor has no compose tool.');
	return { executor, tool };
}

/** Run one compose call and read the result, or the message of a refusal. */
async function call(tool: ReturnType<typeof seatOf>['tool'], args: unknown) {
	try {
		const raw = await invokeTool(tool, args, {
			agent: { name: 'worker', identity: 'Worker.' },
			callId: 'c1',
			room: 'lab',
			deadline: Date.now() + 60_000,
		});
		if (typeof raw === 'string') throw new Error('compose returned a string.');
		const text = raw.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
		return { text, result: raw.details as ComposeResult };
	} catch (error) {
		if (!(error instanceof ComposeFailure)) throw error;
		return { text: error.message, result: error.details };
	}
}

describe('composeMacro', () => {
	it('gives a frozen copy that the caller cannot change', () => {
		const args = { type: 'object', properties: { a: { type: 'string' } } };
		const uses = ['echo'];
		const made = composeMacro({ ...macro('a/b'), args, uses });
		args.properties.a.type = 'number';
		uses.push('table');
		expect(made.args).toEqual({ type: 'object', properties: { a: { type: 'string' } } });
		expect(made.uses).toEqual(['echo']);
		expect([Object.isFrozen(made), Object.isFrozen(made.uses), Object.isFrozen(made.args)]).toEqual(
			[true, true, true],
		);
	});

	it.each([
		['a blank description', { description: ' ' }, 'description must be text that is not blank'],
		['no uses', { uses: [] }, 'uses must be a non-empty list of tool names'],
		['a uses entry that is not text', { uses: ['echo', 3] }, 'uses must be a non-empty list'],
		['no args', { args: undefined }, 'args must be a JSON Schema object'],
		['args that are a list', { args: [] }, 'args must be a JSON Schema object'],
		['an unknown type', { args: { type: 'banana' } }, 'args is not a JSON Schema'],
		[
			'a pattern that is no regular expression',
			{ args: { pattern: '(' } },
			'args is not a JSON Schema',
		],
		['a reference', { args: { $ref: '#/$defs/a' } }, "the keyword '$ref' at the top"],
		['a format', { args: { type: 'string', format: 'uri' } }, "the keyword 'format' at the top"],
		[
			'a keyword that Check ignores, in a property',
			{ args: { type: 'object', properties: { a: { type: 'string', bogus: 1 } } } },
			"the keyword 'bogus' at properties.a",
		],
		[
			'an unknown keyword in a branch',
			{ args: { anyOf: [{ type: 'string' }, { type: 'number', nope: true }] } },
			"the keyword 'nope' at anyOf[1]",
		],
	])('refuses %s', (_name, fields, message) => {
		expect(() => composeMacro({ ...macro('a/b'), ...fields } as ComposeMacro)).toThrow(message);
	});

	it('takes a schema with branches, a pattern, and a closed object', () => {
		const args = {
			type: 'object',
			properties: { id: { anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^[a-z]+$' }] } },
			additionalProperties: false,
			required: ['id'],
		};
		expect(composeMacro({ ...macro('a/b'), args }).args).toEqual(args);
	});
});

describe('the definition of a seat with macros', () => {
	it.each([
		['a tool that the catalog lacks', [macro('a/b', ['echo', 'missing'])], "uses 'missing'"],
		['a tool with compose false', [macro('a/b', ['hidden'])], "uses 'hidden'"],
		['the compose tool itself', [macro('a/b', ['compose'])], "uses 'compose'"],
		[
			'two macros of one name',
			[macro('a/b'), macro('a/b', ['table'])],
			"Two macros are named 'a/b'",
		],
	])('refuses %s', (_name, macros, message) => {
		expect(() => seatOf(carrying(...macros))).toThrow(AmbionError);
		expect(() => seatOf(carrying(...macros))).toThrow(message);
	});

	it('refuses two macros of one name across two bundles', () => {
		const second: ToolBundle = { tools: [], macros: [macro('a/b')] };
		expect(() =>
			describeExecutor({
				kind: 'test',
				instructions: 'Test.',
				bundles: [carrying(macro('a/b')), second],
				compose: { runtime: functionRuntime },
			}),
		).toThrow("Two macros are named 'a/b'");
	});

	it('refuses a bundle macro that composeMacro did not make', () => {
		const forged = {
			name: 'a/b',
			description: 'x',
			uses: ['echo'],
			args: { type: 'banana' },
			code: '',
			hash: 'h',
		};
		expect(() => seatOf(carrying(forged))).toThrow(
			"The macro 'a/b' is not valid: args is not a JSON Schema",
		);
		expect(() => seatOf(carrying(null as unknown as ComposeMacro))).toThrow(
			'A bundle macro must be an object.',
		);
	});

	it('lists the macros in the guidance of compose, one line each, and not in the description', () => {
		const { executor, tool } = seatOf(carrying(macro('a/b'), macro('c/d', ['table'])));
		expect(executor.guidance).toBe(
			`${COMPOSE_GUIDANCE}\n\nThe macros of your skills. Run one with compose({ macro, args }):\n- a/b: Echo the label. Second line of a/b.\n- c/d: Echo the label. Second line of c/d.`,
		);
		expect(tool.description).not.toContain('a/b');
	});

	it('ignores macros on a seat without compose, and the guidance lists none', () => {
		const executor = describeExecutor({
			kind: 'test',
			instructions: 'Test.',
			bundles: [carrying(macro('a/b', ['missing']), macro('a/b'))],
		});
		expect(executor.tools.map((tool) => tool.name)).toEqual(['echo', 'table', 'total', 'hidden']);
		expect(executor.guidance).toBeUndefined();
	});

	it('lists the macros after a guidance that the option replaces', () => {
		const executor = describeExecutor({
			kind: 'test',
			instructions: 'Test.',
			bundles: [carrying(macro('a/b'))],
			compose: { runtime: functionRuntime, guidance: '  ' },
		});
		expect(executor.guidance).toMatch(/^The macros of your skills\./);
	});
});

describe('a compose call that runs a macro', () => {
	const bundle = carrying(macro('lab/echo-label'));

	it('runs the stored code under the stored uses, with the args', async () => {
		const { tool } = seatOf(bundle);
		const ran = await call(tool, { macro: 'lab/echo-label', args: { label: 'drift', count: 3 } });
		expect(ran.text).toBe('"drift:3"');
		expect(ran.result.calls.map((entry) => [entry.tool, entry.status])).toEqual([
			['echo', 'completed'],
		]);
	});

	it('takes absent args as an empty object', async () => {
		const open = carrying(
			macro('lab/open', ['echo'], {
				args: { type: 'object', additionalProperties: false },
				code: 'return Object.keys(args).length;',
			}),
		);
		expect((await call(seatOf(open).tool, { macro: 'lab/open' })).text).toBe('0');
		const strict = await call(seatOf(bundle).tool, { macro: 'lab/echo-label' });
		expect(strict.text).toContain('must have required properties label');
	});

	it('binds only the uses of the macro, so code that names another tool fails', async () => {
		const narrow = carrying(
			macro('lab/narrow', ['echo'], { code: 'return await tools.table({ count: 1 });' }),
		);
		const ran = await call(seatOf(narrow).tool, { macro: 'lab/narrow', args: { label: 'x' } });
		expect(ran.result.status).toBe('failed');
		expect(ran.text).toContain('table');
		expect(ran.result.calls).toEqual([]);
	});

	it('gives approve the name, the hash, and the args of a macro, and the code of free code', async () => {
		const seen: ComposeRequest[] = [];
		const { tool } = seatOf(bundle, (request) => {
			seen.push(request);
			return 'allow';
		});
		await call(tool, { macro: 'lab/echo-label', args: { label: 'a' } });
		await call(tool, { macro: 'lab/echo-label', args: { label: 'b', count: 2 } });
		await call(tool, { uses: ['echo'], code: "return await tools.echo({ text: 'free' });" });
		expect(seen).toEqual([
			{ macro: 'lab/echo-label', hash: 'hash-of-lab/echo-label', args: { label: 'a' } },
			{ macro: 'lab/echo-label', hash: 'hash-of-lab/echo-label', args: { label: 'b', count: 2 } },
			{ uses: ['echo'], code: "return await tools.echo({ text: 'free' });" },
		]);
	});

	it('lets a host deny free code and allow its own macros', async () => {
		const { tool } = seatOf(bundle, (request) => ('macro' in request ? 'allow' : 'deny'));
		expect((await call(tool, { macro: 'lab/echo-label', args: { label: 'ok' } })).text).toBe(
			'"ok:1"',
		);
		const denied = await call(tool, { uses: ['echo'], code: 'return 1;' });
		expect(denied.text).toContain('The approval refused this compose call.');
	});

	it.each([
		[
			'args that break the schema',
			{ macro: 'lab/echo-label', args: { label: '' } },
			'label must not have fewer than 1 characters',
		],
		[
			'args with a key that the schema closes',
			{ macro: 'lab/echo-label', args: { label: 'a', extra: 1 } },
			'do not match its schema',
		],
		[
			'args of the wrong kind',
			{ macro: 'lab/echo-label', args: 'drift' },
			'do not match its schema',
		],
		[
			'an unknown macro',
			{ macro: 'lab/nothing', args: {} },
			"No macro is named 'lab/nothing'. The macros are 'lab/echo-label'.",
		],
		[
			'a macro with code',
			{ macro: 'lab/echo-label', args: { label: 'a' }, code: 'return 1;' },
			'Give macro and args, or uses and code.',
		],
		[
			'free code with args',
			{ uses: ['echo'], code: 'return 1;', args: {} },
			'Give args with macro.',
		],
		['free code with no uses', { code: 'return 1;' }, 'Give uses and code, or macro and args.'],
		[
			'args that are not JSON',
			{ macro: 'lab/echo-label', args: { label: () => 1 } },
			'The arguments of the macro are not JSON',
		],
	])('refuses %s, with no ledger, no approval, and no evaluation', async (_name, args, message) => {
		let evaluated = 0;
		let asked = 0;
		const { tool } = seatOf(
			bundle,
			() => {
				asked += 1;
				return 'allow';
			},
			{
				evaluate: async () => {
					evaluated += 1;
					return undefined;
				},
			},
		);
		const ran = await call(tool, args);
		expect(ran.text).toContain(message);
		expect(ran.result).toMatchObject({ status: 'failed', calls: [] });
		expect([asked, evaluated]).toEqual([0, 0]);
	});

	it('says that a seat holds no macro when it holds none', async () => {
		const ran = await call(seatOf({ tools: [echo] }).tool, { macro: 'a/b' });
		expect(ran.text).toContain('Your skills hold no macro.');
	});

	it('gives the code no args when it is free code', async () => {
		const { tool } = seatOf(bundle);
		const ran = await call(tool, { uses: [], code: 'return typeof args;' });
		expect(ran.text).toBe('"undefined"');
	});
});
