/**
 * A tool is a shape and a body. The shape is the contract a role names, and
 * the body is what one binder brings. Three binders bring one: the room, a
 * workspace, and an agent.
 */
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { defineAgent, defineTool, defineToolShape, SAY, SEAT, SUMMARISE } from '../src/define.ts';
import { handsFor } from '../src/seat/hands.ts';
import type { ActivationView, ToolName } from '../src/wire.ts';

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

describe('the shapes the room binds', () => {
	it('publishes one for each tool it binds', () => {
		expect([SAY.name, SUMMARISE.name, SEAT.name]).toEqual(['say', 'summarise', 'seat']);
	});

	/**
	 * The room builds its tools from the shapes it publishes. A tool that
	 * states its own name and parameters again reads the same to a model, and
	 * a role that names the shape stops reaching it.
	 *
	 * `handsFor` reads nothing off what an activation holds while it builds, so
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
	const held = {} as Parameters<typeof handsFor>[2];

	it.each([
		['say', {}, SAY],
		['summarise', { closing: { person: 'priya', from: 1, through: 2 } }, SUMMARISE],
		['seat', { composing: { person: 'priya', from: 1, limit: 1 } }, SEAT],
	])('builds %s from the shape it published', (name, over, shape) => {
		const [bound] = handsFor({ ...view, tool: name as ToolName, ...over }, agent, held);
		expect(bound?.name).toBe(name);
		expect(bound?.parameters).toBe(shape.parameters);
	});
});
