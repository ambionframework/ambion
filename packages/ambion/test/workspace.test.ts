/**
 * What the core owns of a workspace: the handle, the resolver, and the four
 * hands it binds to a connected agent.
 *
 * The core names `WorkspaceBackend` as a port and holds no filesystem, so
 * every test here runs on a fake backend (`support/workspace.ts`). What the
 * four tools do against a real filesystem belongs to the package that holds
 * one: `@ambionframework/workspace`, `test/workspace.test.ts`.
 */
import type { Context } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import {
	type AgentDefinition,
	defineAgent,
	defineTool,
	defineWorkspace,
	destroyWorkspace,
	type Session,
	startSession,
	type ToolContext,
	type WorkspaceBackend,
} from '../src/index.ts';
import { assistant, enter, roomName as name } from './support/room.ts';
import { byAgent, callTool, quiet, type Script, scripted, toolNames } from './support/scripted.ts';
import { fakeBackend } from './support/workspace.ts';

/** Every tool result the model has been shown so far, oldest first. */
function toolResults(context: Context): { tool: string; text: string; failed: boolean }[] {
	return context.messages.flatMap((message) => {
		if (message.role !== 'toolResult') return [];
		const text = message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
		return [{ tool: message.toolName, text, failed: message.isError }];
	});
}

function agent(agentName: string, options: Partial<Parameters<typeof defineAgent>[0]> = {}) {
	return defineAgent({
		name: agentName,
		identity: 'Works in a workspace.',
		instructions: 'work',
		model: `scripted/${agentName}`,
		...options,
	});
}

/** One room, one delivery, and the seats' scripts; resolves when the room settles. */
async function run(agents: AgentDefinition[], seats: Record<string, Script>): Promise<Session> {
	const session = startSession({
		name: name('workspace'),
		assistant,
		agents,
		streamFn: scripted(byAgent(seats)),
	});
	const visit = await enter(session);
	await visit.deliver({ text: 'go' });
	await session.settled();
	return session;
}

// -- defineWorkspace ---------------------------------------------------------

describe('defineWorkspace', () => {
	it('holds one handle per name until destroyWorkspace frees it', async () => {
		const backend = fakeBackend();
		const site = defineWorkspace({ name: 'core-site-once', backend });
		expect(site.name).toBe('core-site-once');
		expect(() => defineWorkspace({ name: 'core-site-once', backend })).toThrow(/already defined/);
		await destroyWorkspace(site);
		await destroyWorkspace(site); // terminal, and a second call does nothing
		expect(backend.destroys).toBe(1);
		const again = defineWorkspace({ name: 'core-site-once', backend: fakeBackend() });
		expect(again).not.toBe(site);
		await destroyWorkspace(again);
	});

	it('stays live when the backend fails to delete, so a retry is possible', async () => {
		let attempts = 0;
		const flaky: WorkspaceBackend = {
			connect: async () => fakeBackend().connect(agent('nobody')),
			destroy: async () => {
				if (++attempts === 1) throw new Error('disk busy');
			},
		};
		const site = defineWorkspace({ name: 'core-site-flaky', backend: flaky });
		await expect(destroyWorkspace(site)).rejects.toThrow('disk busy');
		expect(() => defineWorkspace({ name: 'core-site-flaky', backend: fakeBackend() })).toThrow(
			/already defined/,
		);
		await destroyWorkspace(site);
		expect(attempts).toBe(2);
		await destroyWorkspace(defineWorkspace({ name: 'core-site-flaky', backend: fakeBackend() }));
	});

	it('refuses a name the room could not address', () => {
		expect(() => defineWorkspace({ name: 'Team Site', backend: fakeBackend() })).toThrow(
			/Invalid workspace name/,
		);
	});

	/**
	 * A handle over a missing backend fails at the first tool call, and traps
	 * its name: `destroyWorkspace` throws before it frees the name, and every
	 * retry throws the same. The check is where the backend is named.
	 */
	it('refuses a backend that is missing or does not answer the port', () => {
		const missing = undefined as unknown as WorkspaceBackend;
		expect(() => defineWorkspace({ name: 'core-no-backend', backend: missing })).toThrow(
			/needs a backend/,
		);
		const half = { connect: async () => fakeBackend().connect(agent('nobody')) };
		expect(() =>
			defineWorkspace({ name: 'core-no-backend', backend: half as unknown as WorkspaceBackend }),
		).toThrow(/needs a backend/);
		// A refused handle takes no name: the same name is free.
		const site = defineWorkspace({ name: 'core-no-backend', backend: fakeBackend() });
		expect(site.name).toBe('core-no-backend');
	});

	it('keeps the four built-in names free for an agent that names a workspace', async () => {
		const site = defineWorkspace({ name: name('reserved'), backend: fakeBackend() });
		const read = defineTool({
			name: 'read',
			description: 'A custom read.',
			parameters: Type.Object({}),
			execute: () => 'custom',
		});
		expect(() => agent('clash', { workspace: site, tools: [read] })).toThrow(
			/'read' is a built-in/,
		);
		expect(() => agent('free', { tools: [read] })).not.toThrow();
		expect(() =>
			agent('other', { workspace: site, tools: [{ name: 'bash', execute() {} }] }),
		).toThrow(/'bash' is a built-in/);
		expect(() => agent('fake', { workspace: { name: 'x' } as never })).toThrow(
			/must come from defineWorkspace/,
		);
		await destroyWorkspace(site);
	});

	it('refuses an assistant that names a workspace', async () => {
		const site = defineWorkspace({ name: name('assistant'), backend: fakeBackend() });
		const connected = agent('assistant', { workspace: site });
		expect(() =>
			startSession({ name: name('workspace'), assistant: connected, agents: [] }),
		).toThrow(/names a workspace/);
		await destroyWorkspace(site);
	});
});

// -- the built-in tools ------------------------------------------------------

describe('the built-in tools', () => {
	it('bind read, write, edit and bash to a connected agent, and nothing to a plain one', async () => {
		const site = defineWorkspace({ name: name('hands'), backend: fakeBackend() });
		const seen = new Map<string, string[]>();
		await run([agent('connected', { workspace: site }), agent('plain')], {
			connected: (context, who) => {
				seen.set(who, toolNames(context));
				return quiet();
			},
			plain: (context, who) => {
				seen.set(who, toolNames(context));
				return quiet();
			},
		});
		expect(seen.get('connected')).toEqual(['say', 'read', 'write', 'edit', 'bash']);
		expect(seen.get('plain')).toEqual(['say']);
		await destroyWorkspace(site);
	});

	it("states the workspace's reach in a connected agent's system prompt, and nothing to a plain one", async () => {
		const site = defineWorkspace({ name: name('briefed'), backend: fakeBackend() });
		const prompts: Record<string, string> = {};
		await run([agent('connected', { workspace: site }), agent('plain')], {
			connected: (context, who) => {
				prompts[who] = context.systemPrompt ?? '';
				return quiet();
			},
			plain: (context, who) => {
				prompts[who] = context.systemPrompt ?? '';
				return quiet();
			},
		});
		expect(prompts.connected).toContain('Your workspace gives you four tools');
		expect(prompts.connected).toContain('js-exec');
		expect(prompts.connected).toContain('no network');
		expect(prompts.plain).not.toContain('Your workspace gives you four tools');
		await destroyWorkspace(site);
	});

	it('fail on the next call once the workspace is destroyed, and the activation goes on', async () => {
		const site = defineWorkspace({ name: name('destroyed'), backend: fakeBackend() });
		let after: { tool: string; text: string; failed: boolean }[] = [];
		await run([agent('worker', { workspace: site })], {
			worker: async (context, _who, call) => {
				if (call === 1) {
					await destroyWorkspace(site);
					return callTool('read', { path: 'anything.txt' });
				}
				after = toolResults(context);
				return quiet();
			},
		});
		expect(after[0]).toMatchObject({ tool: 'read', failed: true });
		expect(after[0]?.text).toMatch(/is destroyed/);
	});
});

// -- ToolContext -------------------------------------------------------------

describe('ToolContext', () => {
	it('hands a custom tool its workspace, fresh on every call, and undefined without one', async () => {
		const backend = fakeBackend();
		const site = defineWorkspace({ name: name('context'), backend });
		const seen: Record<string, string> = {};
		const where = defineTool({
			name: 'where',
			description: 'Names the workspace and its home.',
			parameters: Type.Object({}),
			execute: async (_params, ctx: ToolContext) => {
				const workspace = await ctx.workspace();
				const signal = ctx.signal instanceof AbortSignal ? 'signal' : 'no signal';
				if (!workspace) return `nowhere, ${signal}`;
				return `${workspace.name} at ${workspace.env.cwd}, ${signal}`;
			},
		});
		await run(
			[agent('inside', { workspace: site, tools: [where] }), agent('outside', { tools: [where] })],
			{
				inside: (context, who, call) => {
					if (call <= 2) return callTool('where', {});
					seen[who] = toolResults(context)
						.map((r) => r.text)
						.join(' | ');
					return quiet();
				},
				outside: (context, who, call) => {
					if (call === 1) return callTool('where', {});
					seen[who] = toolResults(context)
						.map((r) => r.text)
						.join(' | ');
					return quiet();
				},
			},
		);
		expect(seen.inside).toBe(
			`${site.name} at /home/inside, signal | ${site.name} at /home/inside, signal`,
		);
		expect(seen.outside).toBe('nowhere, signal');
		expect(backend.connected).toEqual(['inside', 'inside']); // one connect per call, none cached
		await destroyWorkspace(site);
	});

	it("makes a connect failure the tool call's failure", async () => {
		const broken: WorkspaceBackend = {
			connect: async () => {
				throw new Error('no such host');
			},
			destroy: async () => {},
		};
		const site = defineWorkspace({ name: name('broken'), backend: broken });
		let result: { tool: string; text: string; failed: boolean } | undefined;
		await run([agent('unlucky', { workspace: site })], {
			unlucky: (context, _who, call) => {
				if (call === 1) return callTool('bash', { command: 'true' });
				result = toolResults(context)[0];
				return quiet();
			},
		});
		expect(result).toMatchObject({ tool: 'bash', failed: true });
		expect(result?.text).toContain('no such host');
		await destroyWorkspace(site);
	});
});
