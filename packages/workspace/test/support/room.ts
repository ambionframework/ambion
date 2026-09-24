/**
 * A room over scripted seats, for the tests that drive the workspace tools
 * through a real room: `run` starts one, asks one question, and resolves at
 * the exchange close. `toolResults` reads what the model has been shown.
 */
import { type AgentDefinition, type Room, startRoom } from '@ambionframework/ambion';
import { type PiOptions, piExecution } from '@ambionframework/pi';
import type { Context } from '@earendil-works/pi-ai';
import { enter, roomName as name, scriptedAgent } from '../../../ambion/test/support/room.ts';
import { byAgent, type Script, scripted } from '../../../ambion/test/support/scripted.ts';
import { stopAtEnd } from '../../../ambion/test/support/stop.ts';

/** Every tool result the model has been shown so far, oldest first. */
export function toolResults(context: Context): { tool: string; text: string; failed: boolean }[] {
	return context.messages.flatMap((message) => {
		if (message.role !== 'toolResult') return [];
		const text = message.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
		return [{ tool: message.toolName, text, failed: message.isError }];
	});
}

/** A seat on the scripted model. */
export const agent = (agentName: string, options: Partial<PiOptions> = {}) =>
	scriptedAgent(agentName, undefined, options);

/** One room, one question, and the seats' scripts; resolves at the exchange close. */
export async function run(agents: AgentDefinition[], seats: Record<string, Script>): Promise<Room> {
	const session = stopAtEnd(
		await startRoom({
			name: name('workspace'),
			agents,
			execution: piExecution({ sessions: 'memory', stream: scripted(byAgent(seats)) }),
		}),
	);
	const visit = await enter(session);
	const exchange = await visit.send({ text: 'go' });
	await exchange.waitForClose();
	return session;
}
