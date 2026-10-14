/**
 * The compose extension of a seat: the check of its options, the names it
 * reserves, and the tools and guidance that it appends to the seat.
 */
import { type AmbionTool, defineAgent, defineTool, type ToolBundle } from '@ambionframework/ambion';
import { describeExecutor } from '@ambionframework/ambion/hosting';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { refusal } from '../../ambion/test/support/errors.ts';
import { COMPOSE_PROCESS_GUIDANCE } from '../src/compose.ts';
import {
	COMPOSE_GUIDANCE,
	type ComposeOptions,
	composeExtension,
	composeMacro,
} from '../src/index.ts';

const tool = (name: string): AmbionTool =>
	defineTool({
		name,
		description: `Runs ${name}.`,
		parameters: Type.Object({}),
		execute: () => 'done',
	});

const ok = { evaluate: async () => undefined };

/** An executor with the compose extension, over the tools and bundles given. */
function seat(
	options: { tools?: AmbionTool[]; bundles?: ToolBundle[] } = {},
	compose: ComposeOptions = { runtime: ok },
) {
	return describeExecutor({
		kind: 'scripted',
		instructions: 'Work.',
		...options,
		extensions: [composeExtension(compose)],
	});
}

describe('the compose extension', () => {
	it.each([
		['compose', { tools: [tool('compose')] }],
		['describe', { tools: [tool('describe')] }],
		['compose in a bundle', { bundles: [{ tools: [tool('compose')] }] }],
		['describe in a bundle', { bundles: [{ tools: [tool('describe')] }] }],
	])('refuses a tool named %s', (_name, options) => {
		expect(() => seat(options)).toThrow(/the names 'compose' and 'describe' are reserved/);
		expect(() => seat(options)).toThrow(refusal('invalid_tool'));
	});

	it.each([
		['the value false', false],
		['an option with no runtime', {}],
		['a runtime with no evaluate', { runtime: {} }],
		['an approve that is not a function', { runtime: ok, approve: 'yes' }],
		['guidance that is not a string', { runtime: ok, guidance: 1 }],
		['limits that are not an object', { runtime: ok, limits: 3 }],
		['limits that are an array', { runtime: ok, limits: [] }],
		['a limit of zero', { runtime: ok, limits: { calls: 0 } }],
		['a limit of a fraction', { runtime: ok, limits: { time: 1.5 } }],
		['a limit that has no name', { runtime: ok, limits: { speed: 2 } }],
	])('refuses an option with %s', (_name, compose) => {
		expect(() => composeExtension(compose as never)).toThrow(/Agent compose/);
	});

	it('appends the compose and describe tools after the tools and the bundles', () => {
		const hidden = defineTool({
			name: 'hidden',
			description: 'Stays out.',
			parameters: Type.Object({}),
			compose: false,
			execute: () => 'x',
		});
		const bundle = { tools: [tool('inspect')], guidance: 'Use inspect.' };
		const executor = seat({ tools: [tool('lookup'), hidden], bundles: [bundle] });
		expect(executor).not.toHaveProperty('compose');
		expect(executor.tools.map((one) => one.name)).toEqual([
			'lookup',
			'hidden',
			'inspect',
			'compose',
			'describe',
		]);
		// The guidance of the bundles comes first, and the guidance of compose follows it.
		expect(executor.guidance).toBe(`Use inspect.\n\n${COMPOSE_GUIDANCE}`);
	});

	it('adds the process lines to a seat that holds bash, and to no other', () => {
		expect(COMPOSE_GUIDANCE).not.toMatch(/\bbash\b|\bwait\b|handle/);
		expect(seat().guidance).toBe(COMPOSE_GUIDANCE);
		expect(seat({ tools: [tool('bash')] }).guidance).toBe(
			`${COMPOSE_GUIDANCE}\n\n${COMPOSE_PROCESS_GUIDANCE}`,
		);
	});

	it('takes the guidance of the option, and none for a blank one', () => {
		expect(seat({}, { runtime: ok, guidance: 'Compose often.' }).guidance).toBe('Compose often.');
		expect(seat({}, { runtime: ok, guidance: '  ' })).not.toHaveProperty('guidance');
	});

	it('runs after the other extensions, and does not bind their tools', () => {
		const executor = describeExecutor({
			kind: 'scripted',
			instructions: 'Work.',
			tools: [tool('lookup')],
			extensions: [
				() => ({ tools: [tool('extra')], guidance: 'Use extra.' }),
				composeExtension({ runtime: ok }),
			],
		});
		expect(executor.tools.map((one) => one.name)).toEqual([
			'lookup',
			'extra',
			'compose',
			'describe',
		]);
		const describer = executor.tools.find((one) => one.name === 'describe');
		expect(() => describer?.invoke({ tools: ['extra'] }, {} as never)).toThrow(
			"The catalog holds no tool named 'extra'",
		);
	});

	it('adds no tool, no guidance, and no macro check to an executor with no compose extension', () => {
		const macro = composeMacro({
			name: 'bundle/orphan',
			description: 'Calls a tool that the catalog lacks.',
			uses: ['missing'],
			code: 'return 1;',
			args: { type: 'object', properties: {} },
			hash: 'orphan',
		});
		const executor = describeExecutor({
			kind: 'scripted',
			instructions: 'Work.',
			tools: [tool('lookup')],
			bundles: [{ tools: [], macros: [macro] }],
		});
		expect(executor.tools.map((one) => one.name)).toEqual(['lookup']);
		expect(executor).not.toHaveProperty('guidance');
	});

	it('refuses a second compose tool in a definition, and treats a hand-built compose tool as an ordinary one', () => {
		const withCompose = seat();
		const twin = { ...withCompose, tools: [...withCompose.tools, tool('compose')] };
		expect(() => defineAgent({ name: 'twin', identity: 'Twin.', executor: twin })).toThrow(
			"brings duplicate tools named 'compose'",
		);
		const own = { kind: 'scripted', instructions: 'Work.', tools: [tool('compose')] };
		expect(() => defineAgent({ name: 'own', identity: 'Own.', executor: own })).not.toThrow();
	});
});
