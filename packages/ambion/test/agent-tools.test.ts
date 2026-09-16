import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { defineAgent, defineHuman, defineTool, type ToolBundle } from '../src/index.ts';

const tool = (name: string) =>
	defineTool({
		name,
		description: 'Does one thing.',
		parameters: Type.Object({}),
		execute: () => 'done',
	});

describe('agent tools', () => {
	it.each(['reader\n', 'reader\r\n', 12, undefined])(
		'rejects participant names that are not exact lowercase identifiers: %j',
		(name) => {
			const agent = {
				name: 'reader',
				identity: 'An agent.',
				instructions: 'Read.',
				model: 'scripted/reader',
			};
			const human = { name: 'priya', identity: 'A person.' };
			expect(() => Reflect.apply(defineAgent, undefined, [{ ...agent, name }])).toThrow(
				/Invalid participant name/,
			);
			expect(() => Reflect.apply(defineHuman, undefined, [{ ...human, name }])).toThrow(
				/Invalid participant name/,
			);
		},
	);

	it('accepts an ordinary domain tool name with an underscore', () => {
		expect(() => tool('lookup_order')).not.toThrow();
	});

	it('allows an ordinary tool named read without a workspace bundle', () => {
		expect(() =>
			defineAgent({
				name: 'reader',
				identity: 'An agent.',
				instructions: 'Read.',
				model: 'scripted/reader',
				tools: [tool('read')],
			}),
		).not.toThrow();
	});

	it('keeps the three names a room supplies free for its activation tools', () => {
		for (const name of ['say', 'seat', 'summarise']) {
			expect(() =>
				defineAgent({
					name: `agent-${name}`,
					identity: 'An agent.',
					instructions: 'Work.',
					model: 'scripted/agent',
					tools: [tool(name)],
				}),
			).toThrow(/room supplies it for an activation/);
		}
	});

	it('rejects duplicate ordinary names after flattening a bundle', () => {
		const bundle: ToolBundle = { tools: [tool('read')] };
		expect(() =>
			defineAgent({
				name: 'workspace-reader',
				identity: 'An agent.',
				instructions: 'Read.',
				model: 'scripted/reader',
				tools: [tool('read')],
				bundles: [bundle],
			}),
		).toThrow(/duplicate tools named 'read'/);
	});

	it('allows an agent-defined tool with an unrelated name', () => {
		expect(() =>
			defineAgent({
				name: 'flagger',
				identity: 'An agent.',
				instructions: 'Flag.',
				model: 'scripted/flagger',
				tools: [tool('flag')],
			}),
		).not.toThrow();
	});

	it('captures caller-owned tool arrays, records, and schemas', () => {
		const parameters = Type.Object({ query: Type.String() });
		const supplied = {
			...defineTool({
				name: 'inspect',
				description: 'Inspects one thing.',
				parameters,
				execute: () => 'first',
			}),
		};
		const tools = [supplied];
		const agent = defineAgent({
			name: 'inspector',
			identity: 'An inspector.',
			instructions: 'Inspect.',
			model: 'scripted/inspector',
			tools,
		});

		tools.length = 0;
		supplied.name = 'changed';
		supplied.description = 'Changed after capture.';
		(parameters.properties as Record<string, unknown>).query = Type.Number();

		const captured = agent.tools[0];
		expect(agent.tools).toHaveLength(1);
		expect(captured).toMatchObject({ name: 'inspect', description: 'Inspects one thing.' });
		expect(captured).not.toBe(supplied);
		expect(captured?.parameters).not.toBe(parameters);
		expect(captured?.parameters).toMatchObject({ properties: { query: { type: 'string' } } });
		expect(Object.isFrozen(agent)).toBe(true);
		expect(Object.isFrozen(agent.tools)).toBe(true);
	});
});
