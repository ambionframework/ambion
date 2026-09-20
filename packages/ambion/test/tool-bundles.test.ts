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
	type PiOptions,
	pi,
	type Room,
	startRoom,
	type ToolBundle,
	type ToolContext,
} from '../src/index.ts';
import {
	byAgent,
	callTool,
	quiet,
	type Script,
	scripted,
	settled,
	speak,
} from '../src/testing.ts';
import { assistant, collect, enter, messagesOf, roomName as name } from './support/room.ts';

function agent(agentName: string, options: Partial<PiOptions> = {}) {
	return defineAgent({
		name: agentName,
		identity: `Identity of ${agentName}.`,
		executor: pi({ instructions: 'work', model: `scripted/${agentName}`, ...options }),
	});
}

/** One room, one delivery, and the seats' scripts; resolves when the room settles. */
async function run(agents: AgentDefinition[], seats: Record<string, Script>): Promise<Room> {
	const session = await startRoom({
		name: name('ordinary-bundles'),
		summary: assistant.name,
		seats: {
			...Object.fromEntries(agents.map((agent) => [agent.name, 'broadcast' as const])),
			[assistant.name]: 'none',
		},
		agents: [...agents, assistant],
		stream: scripted(byAgent(seats)),
	});
	const visit = await enter(session);
	await visit.send({ text: 'go' });
	await settled(session);
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
			executor: pi({ instructions: 'Work.', model: 'scripted/capturer', bundles }),
		});

		bundles.push({ tools: [tool('later')], guidance: 'Later guidance.' });
		bundle.tools.length = 0;
		bundle.guidance = 'Changed guidance.';
		expect(agentDef.executor.tools).toHaveLength(1);
		expect(agentDef.executor.tools[0]?.name).toBe('inspect');
		expect(agentDef.executor.guidance).toBe('Use inspect for this domain.');
		expect(Object.isFrozen(agentDef)).toBe(true);
		expect(Object.isFrozen(agentDef.executor.tools)).toBe(true);
	});

	it('rejects duplicate ordinary names after flattening bundles', () => {
		const inspect = tool('inspect');
		const bundle: ToolBundle = { tools: [inspect] };
		expect(() =>
			defineAgent({
				name: 'duplicate',
				identity: 'Checks names.',
				executor: pi({
					instructions: 'Work.',
					model: 'scripted/duplicate',
					tools: [tool('inspect')],
					bundles: [bundle],
				}),
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

	it('passes the room, the activation, and the open exchange to ordinary tools', async () => {
		const seen: ToolContext[] = [];
		const frozen: boolean[] = [];
		const probe = tool('probe', (ctx) => {
			seen.push(ctx);
			frozen.push(Object.isFrozen(ctx));
			return 'probed';
		});
		const session = await startRoom({
			name: name('ordinary-provenance'),
			summary: assistant.name,
			seats: { worker: 'broadcast', [assistant.name]: 'none' },
			agents: [agent('worker', { tools: [probe] }), assistant],
			stream: scripted(
				byAgent({
					worker: (_context, _who, call) =>
						call === 1 ? callTool('probe', {}) : call === 2 ? speak('done') : quiet(),
				}),
			),
		});
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'go' });
		await settled(session);
		const messages = await messagesOf(session);
		const question = messages.find((message) => message.kind === 'said' && message.text === 'go');
		const said = messages.find((message) => message.kind === 'said' && message.from === 'worker');
		expect(seen).toHaveLength(1);
		expect(seen[0]?.room).toBe(session.name);
		expect(seen[0]?.activation).toBeDefined();
		expect(seen[0]?.activation).toBe(said?.kind === 'said' ? said.activationId : undefined);
		expect(seen[0]?.exchange).toEqual({ owner: 'andrei', from: question?.seq });
		const starts = events.filter(
			(event) => event.type === 'activation_start' && event.agent === 'worker',
		);
		expect(starts.map((event) => 'activation' in event && event.activation)).toEqual([
			seen[0]?.activation,
		]);
		expect(frozen).toEqual([true]);
		await session.stop();
	});

	it('passes no exchange to a tool called in an activation that no question opened', async () => {
		const seen: ToolContext[] = [];
		const probe = tool('probe', (ctx) => {
			seen.push(ctx);
			return 'probed';
		});
		const session = await startRoom({
			name: name('ordinary-no-exchange'),
			summary: assistant.name,
			seats: { greeter: 'presence', [assistant.name]: 'none' },
			agents: [agent('greeter', { tools: [probe] }), assistant],
			stream: scripted(
				byAgent({
					greeter: (_context, _who, call) => (call === 1 ? callTool('probe', {}) : quiet()),
				}),
			),
		});
		await enter(session);
		await settled(session);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.room).toBe(session.name);
		expect(typeof seen[0]?.activation).toBe('string');
		expect(seen[0] !== undefined && 'exchange' in seen[0]).toBe(false);
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
