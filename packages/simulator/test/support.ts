/**
 * Rooms for the scripted tier: every seat runs a script from
 * `@ambionframework/ambion/testing`, and the room stops when the test ends.
 */
import {
	type AgentDefinition,
	defineAgent,
	definePerson,
	type Room,
	startRoom,
} from '@ambionframework/ambion';
import { type Script, scripted } from '@ambionframework/ambion/testing';
import { onTestFinished } from 'vitest';

export const priya = definePerson({ name: 'priya', identity: 'Site manager. Pours concrete.' });

/** A seat that runs on the room's script. */
export function agent(name: string): AgentDefinition {
	return defineAgent({
		name,
		identity: `The ${name} desk.`,
		executor: { kind: 'scripted', instructions: 'Answer.', tools: [] },
	});
}

let unique = 0;

/** A room over `script` with the seats `names`, stopped when the test ends. */
export async function open(
	script: Script,
	names: readonly string[],
	options: { summaryWriter?: string } = {},
): Promise<Room> {
	unique += 1;
	const room = await startRoom({
		name: `simulate-${unique}-${crypto.randomUUID()}`,
		agents: names.map(agent),
		execution: scripted(script),
		...(options.summaryWriter === undefined ? {} : { summaryWriter: options.summaryWriter }),
	});
	onTestFinished(() => room.stop());
	return room;
}

/** A script answer that never arrives: the seat keeps its exchange open. */
export const forever = (): Promise<never> => new Promise<never>(() => {});
