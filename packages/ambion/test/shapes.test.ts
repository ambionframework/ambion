/**
 * A tool is a shape and a body. The shape is the contract a role names, and
 * the body is what one binder brings. Three binders bring one: the room, a
 * workspace, and an agent.
 */
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
	binderOf,
	defineAgent,
	defineTool,
	defineToolShape,
	SAY,
	SEAT,
	SUMMARISE,
} from '../src/define.ts';
import { toolsFor } from '../src/seat/tools.ts';
import { defineWorkspace, destroyWorkspace } from '../src/tools/workspace.ts';
import type { ActivationView, ToolName } from '../src/wire.ts';
import { fakeBackend } from './support/workspace.ts';

const FLAG = defineToolShape({
	name: 'flag',
	parameters: Type.Object({ reason: Type.String() }),
});

describe('a tool shape', () => {
	it('holds the name and the parameters, and no description', () => {
		// A description belongs to a body: the room writes `summarise` with the
		// person it writes for in it, so no two bodies share one.
		expect(FLAG).toEqual({ name: 'flag', parameters: FLAG.parameters });
		expect('description' in FLAG).toBe(false);
	});

	it('refuses a name the room cannot address', () => {
		expect(() => defineToolShape({ name: 'Flag It', parameters: Type.Object({}) })).toThrow(
			/Invalid tool name/,
		);
	});

	it('is carried by the body that answers it, so one comparison says so', () => {
		const tool = defineTool({ shape: FLAG, description: 'Flag it.', execute: async () => 'ok' });
		expect(tool.shape).toBe(FLAG);
		expect(tool.name).toBe('flag');
		expect(tool.parameters).toBe(FLAG.parameters);
		expect(tool.description).toBe('Flag it.');
	});

	it('is absent from a body that states its own name and parameters', () => {
		const tool = defineTool({
			name: 'query',
			description: 'Ask.',
			parameters: Type.Object({ q: Type.String() }),
			execute: async () => 'ok',
		});
		expect(tool.shape).toBeUndefined();
		expect(tool.name).toBe('query');
	});
});

describe('who binds a tool of this name', () => {
	it('gives the room its three, the workspace its four, and the agent the rest', () => {
		expect(['say', 'summarise', 'seat'].map(binderOf)).toEqual(['room', 'room', 'room']);
		expect(['read', 'write', 'edit', 'bash'].map(binderOf)).toEqual([
			'workspace',
			'workspace',
			'workspace',
			'workspace',
		]);
		expect(binderOf('flag')).toBe('agent');
	});

	const bring = (name: string) =>
		defineTool({ name, description: 'd', parameters: Type.Object({}), execute: async () => 'x' });
	const withTool = (name: string) => () =>
		defineAgent({
			name: 'solo',
			identity: 'A.',
			instructions: '.',
			model: 'm',
			tools: [bring(name)],
		});

	/**
	 * An agent that brought `say` reached a model with two tools under one
	 * name, because the room binds its own beside the agent's.
	 */
	it('refuses an agent that brings a name the room binds', () => {
		expect(withTool('say')).toThrow(/the room binds it into every activation/);
		expect(withTool('summarise')).toThrow(/the room binds it into every activation/);
		expect(withTool('seat')).toThrow(/the room binds it into every activation/);
	});

	/**
	 * A workspace binds its four for an agent that names one. An agent that
	 * names none binds nothing under them, so it may take the name.
	 * `workspace.test.ts` holds both halves of that.
	 */
	it('leaves a name only the workspace binds to an agent that names none', () => {
		expect(withTool('read')).not.toThrow();
		const site = defineWorkspace({ name: 'shapes-site', backend: fakeBackend() });
		expect(() =>
			defineAgent({
				name: 'solo',
				identity: 'A.',
				instructions: '.',
				model: 'm',
				workspace: site,
				tools: [bring('bash')],
			}),
		).toThrow(/is a built-in tool a workspace binds/);
		destroyWorkspace(site);
	});

	it('takes every other name', () => {
		expect(() => withTool('flag')()).not.toThrow();
	});
});

describe('the shapes the room binds', () => {
	it('publishes one for each tool it binds', () => {
		expect([SAY.name, SUMMARISE.name, SEAT.name]).toEqual(['say', 'summarise', 'seat']);
	});

	/**
	 * The room builds its tools from the shapes it publishes. A tool that
	 * states its own name and parameters again reads the same to a model, and
	 * a role that names the shape stops reaching it.
	 *
	 * `toolsFor` reads nothing off what an activation holds while it builds, so
	 * the test hands it nothing.
	 */
	const agent = defineAgent({ name: 'solo', identity: 'Answers.', instructions: '.', model: 'm' });
	const view: ActivationView = {
		activation: 'message:1:solo:1',
		seat: 'solo',
		model: 'm',
		lastSeq: 1,
		systemPrompt: '',
		context: '',
		tool: 'say',
	};
	const held = {} as Parameters<typeof toolsFor>[2];

	/**
	 * Every activation that binds `say` reads one parameter schema now, where
	 * each used to build its own. A binder that wrote into the schema it was
	 * given would reach every activation after it.
	 */
	it('leaves the shapes it binds as it found them', () => {
		const before = JSON.stringify([SAY, SUMMARISE, SEAT]);
		for (const [name, over] of [
			['say', {}],
			['summarise', { closing: { person: 'priya', from: 1, through: 2 } }],
			['seat', { composing: { person: 'priya', from: 1, limit: 1 } }],
		] as const) {
			toolsFor({ ...view, tool: name as ToolName, ...over }, agent, held);
			toolsFor({ ...view, tool: name as ToolName, ...over }, agent, held);
		}
		expect(JSON.stringify([SAY, SUMMARISE, SEAT])).toBe(before);
	});

	it.each([
		['say', {}, SAY],
		['summarise', { closing: { person: 'priya', from: 1, through: 2 } }, SUMMARISE],
		['seat', { composing: { person: 'priya', from: 1, limit: 1 } }, SEAT],
	])('builds %s from the shape it published', (name, over, shape) => {
		const [bound] = toolsFor({ ...view, tool: name as ToolName, ...over }, agent, held);
		expect(bound?.name).toBe(name);
		expect(bound?.parameters).toBe(shape.parameters);
	});
});
