/**
 * The core knows ordinary tool composition. A package may provide a bundle
 * with tools and guidance; the core does not know what the bundle reaches.
 */
import type { Context } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
	type AgentDefinition,
	defineAgent,
	defineTool,
	type Room,
	startRoom,
	type ToolBundle,
	type ToolContext,
} from '../src/index.ts';
import { assistant, enter, roomName as name, waitForRoom } from './support/room.ts';
import { byAgent, callTool, quiet, type Script, scripted } from './support/scripted.ts';

function agent(agentName: string, options: Partial<Parameters<typeof defineAgent>[0]> = {}) {
	return defineAgent({
		name: agentName,
		identity: `Identity of ${agentName}.`,
		instructions: 'work',
		model: `scripted/${agentName}`,
		...options,
	});
}

/** One room, one delivery, and the seats' scripts; resolves when the room settles. */
async function run(agents: AgentDefinition[], seats: Record<string, Script>): Promise<Room> {
	const session = await startRoom({
		name: name('ordinary-bundles'),
		assistant,
		agents,
		streamFn: scripted(byAgent(seats)),
	});
	const visit = await enter(session);
	await visit.send({ text: 'go' });
	await waitForRoom(session);
	return session;
}

function tool(toolName: string, execute: (ctx: ToolContext) => string = () => 'done') {
	return defineTool({
		name: toolName,
		description: `Runs ${toolName}.`,
		parameters: Type.Object({}),
		execute: async (_params, ctx) => execute(ctx),
	});
}

describe('ordinary tool bundles', () => {
	it('flattens and captures bundle tools and guidance at definition time', () => {
		const inspect = tool('inspect');
		const bundle = { tools: [inspect], guidance: 'Use inspect for this domain.' };
		const bundles = [bundle];
		const agentDef = defineAgent({
			name: 'capturer',
			identity: 'Captures values.',
			instructions: 'Work.',
			model: 'scripted/capturer',
			bundles,
		});

		bundles.push({ tools: [tool('later')], guidance: 'Later guidance.' });
		bundle.tools.length = 0;
		bundle.guidance = 'Changed guidance.';
		expect(agentDef.tools).toHaveLength(1);
		expect(agentDef.tools[0]?.name).toBe('inspect');
		expect(agentDef.guidance).toBe('Use inspect for this domain.');
		expect(Object.isFrozen(agentDef)).toBe(true);
		expect(Object.isFrozen(agentDef.tools)).toBe(true);
	});

	it('rejects duplicate ordinary names after flattening bundles', () => {
		const inspect = tool('inspect');
		const bundle: ToolBundle = { tools: [inspect] };
		expect(() =>
			defineAgent({
				name: 'duplicate',
				identity: 'Checks names.',
				instructions: 'Work.',
				model: 'scripted/duplicate',
				tools: [tool('inspect')],
				bundles: [bundle],
			}),
		).toThrow(/duplicate tools named 'inspect'/i);
	});

	it('passes stable agent identity and the call signal to ordinary tools', async () => {
		const seen: string[] = [];
		const probe = tool('probe', (ctx) => {
			seen.push(`${ctx.agent.name}:${ctx.agent.identity}:${ctx.signal instanceof AbortSignal}`);
			return seen.at(-1) ?? '';
		});
		const session = await run([agent('worker', { tools: [probe] })], {
			worker: (_context, _who, call) => (call <= 2 ? callTool('probe', {}) : quiet()),
		});
		expect(seen).toEqual(['worker:Identity of worker.:true', 'worker:Identity of worker.:true']);
		await session.stop();
	});

	it('adds bundle guidance to message activations', async () => {
		const prompts: string[] = [];
		const bundle: ToolBundle = {
			tools: [tool('inspect')],
			guidance: 'Backend guidance: inspect records before writing.',
		};
		const session = await run([agent('worker', { bundles: [bundle] })], {
			worker: (context: Context) => {
				prompts.push(context.systemPrompt ?? '');
				return quiet();
			},
		});
		expect(prompts[0]).toContain('Backend guidance: inspect records before writing.');
		await session.stop();
	});
});
