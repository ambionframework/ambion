import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { defineAgent, defineTool, defineWorkspace, destroyWorkspace } from '../src/index.ts';
import { fakeBackend } from './support/workspace.ts';

const tool = (name: string) =>
	defineTool({
		name,
		description: 'Does one thing.',
		parameters: Type.Object({}),
		execute: () => 'done',
	});

describe('agent tools', () => {
	it('accepts an ordinary domain tool name with an underscore', () => {
		expect(() => tool('lookup_order')).not.toThrow();
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

	it('allows a workspace name without a workspace, and reserves it after one is attached', async () => {
		expect(() =>
			defineAgent({
				name: 'reader',
				identity: 'An agent.',
				instructions: 'Read.',
				model: 'scripted/reader',
				tools: [tool('read')],
			}),
		).not.toThrow();
		const workspace = defineWorkspace({ name: 'tool-names', backend: fakeBackend() });
		try {
			expect(() =>
				defineAgent({
					name: 'workspace-reader',
					identity: 'An agent.',
					instructions: 'Read.',
					model: 'scripted/reader',
					workspace,
					tools: [tool('read')],
				}),
			).toThrow(/workspace supplies it for an agent that names one/);
		} finally {
			await destroyWorkspace(workspace);
		}
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
		const supplied: {
			name: string;
			description: string;
			parameters: { properties: Record<string, unknown> };
			execute: () => string;
		} = {
			name: 'inspect',
			description: 'Inspects one thing.',
			parameters,
			execute: () => 'first',
		};
		const tools: unknown[] = [supplied];
		const agent = defineAgent({
			name: 'inspector',
			identity: 'An inspector.',
			instructions: 'Inspect.',
			model: 'scripted/inspector',
			tools,
		});

		tools.push(tool('later'));
		supplied.name = 'changed';
		supplied.description = 'Changed after capture.';
		(parameters.properties as Record<string, unknown>).query = Type.Number();

		const captured = agent.tools[0] as typeof supplied;
		expect(agent.tools).toHaveLength(1);
		expect(captured).toMatchObject({ name: 'inspect', description: 'Inspects one thing.' });
		expect(captured).not.toBe(supplied);
		expect(captured.parameters).not.toBe(parameters);
		expect(captured.parameters.properties.query).toMatchObject({ type: 'string' });
		expect(Object.isFrozen(agent)).toBe(true);
		expect(Object.isFrozen(agent.tools)).toBe(true);
	});
});
