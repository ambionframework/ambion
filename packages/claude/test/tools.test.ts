/**
 * The room tools and the agent's own tools reach the model through one
 * in-process MCP server, with the schemas of the room and full provenance.
 */
import { defineTool } from '@ambionframework/ambion';
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import { open, seat, viewOf } from './support.ts';

it('lists the room tools with JSON Schema beside the agent tools, runs an agent tool with provenance, and gives the model a tool error as an error result', async () => {
	const seen: unknown[] = [];
	const lookup = defineTool({
		name: 'lookup',
		description: 'Look up one record.',
		parameters: Type.Object({
			id: Type.String({ description: 'The record id.' }),
			depth: Type.Optional(Type.Number()),
		}),
		execute: (params, context) => {
			seen.push({ params, ...context });
			return 'found r1';
		},
	});
	const broken = defineTool({
		name: 'broken',
		description: 'Always fails.',
		parameters: Type.Object({}),
		execute: () => {
			throw new Error('The archive is closed.');
		},
	});
	const run = open(
		{
			turns: [
				[{ call: { tool: 'lookup', args: { id: 'r1' } } }, { call: { tool: 'broken', args: {} } }],
			],
		},
		seat({ tools: [lookup, broken] }),
	);
	await run.session.pass({ kind: 'view', view: viewOf() });
	// The fake lists the tools when it first calls one.
	const listed = run.log().find((line) => 'tools' in line)?.tools as {
		name: string;
		inputSchema: {
			properties: Record<string, { description?: string }>;
			required?: string[];
		};
	}[];
	expect(listed.map((tool) => tool.name).sort()).toEqual([
		'broken',
		'dismiss',
		'lookup',
		'say',
		'seat',
		'unseat',
	]);
	const say = listed.find((tool) => tool.name === 'say');
	expect(Object.keys(say?.inputSchema.properties ?? {}).sort()).toEqual([
		'after',
		'refs',
		'text',
		'to',
	]);
	expect(say?.inputSchema.required).toEqual(['text']);
	const found = listed.find((tool) => tool.name === 'lookup');
	expect(found?.inputSchema.properties.id?.description).toBe('The record id.');
	expect(found?.inputSchema.required).toEqual(['id']);
	expect(seen).toEqual([
		{
			params: { id: 'r1' },
			agent: { name: 'sonnet', identity: 'Answers what is asked.' },
			signal: expect.any(AbortSignal),
			callId: expect.stringMatching(/^toolu_/),
			room: 'lab',
			activation: 'message:1:sonnet:1',
			exchange: { owner: 'priya', from: 1 },
		},
	]);
	const results = run.steps.filter((step) => step.type === 'tool_result');
	expect(results).toMatchObject([
		{ output: [{ type: 'text', text: 'found r1' }] },
		{ error: 'The archive is closed.' },
	]);
	run.session.close?.();
});
