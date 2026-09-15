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
});
