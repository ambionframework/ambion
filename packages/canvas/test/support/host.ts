import {
	type AgentDefinition,
	createRuntime,
	defineAgent,
	type Room,
} from '@ambionframework/ambion';
import { describeExecutor } from '@ambionframework/ambion/hosting';
import { byAgent, type Script, scripted } from '@ambionframework/ambion/testing';
import { type JournalOpener, memoryJournals } from '@ambionframework/journal';
import { onTestFinished } from 'vitest';
import {
	type Canvas,
	type CanvasError,
	type CanvasRoom,
	type CanvasStore,
	memoryCanvas,
	type OpenCanvasOptions,
	openCanvas,
} from '../../src/index.ts';

/** An agent on the scripted executor. */
export const agent = (name: string): AgentDefinition =>
	defineAgent({
		name,
		identity: `${name}.`,
		executor: describeExecutor({ kind: 'scripted', instructions: 'Answer.', bundles: [] }),
	});

export const ada = agent('ada');
export const bob = agent('bob');
export const cy = agent('cy');
export const helper = agent('helper');

/** The row of a breakout room, as a later release writes it. */
export const breakoutRow = (
	name: string,
	parent: string,
	agents: readonly string[] = ['cy'],
): CanvasRoom => ({
	name,
	goal: `Work for ${name}.`,
	depth: 1,
	state: 'running',
	start: { kind: 'breakout', parent, opener: 'ada', agents, message: 'Start.' },
});

export interface Host {
	readonly canvas: Canvas;
	readonly store: CanvasStore;
	readonly storage: JournalOpener;
	readonly errors: CanvasError[];
}

type HostOptions = Partial<Pick<OpenCanvasOptions, 'workspace' | 'breakout'>> & {
	store?: CanvasStore;
	storage?: JournalOpener;
	script?: Script;
};

/**
 * One run of a host: a canvas over a real runtime. Two hosts that share `store` and
 * `storage` stand for a restart. The canvas closes when the test ends.
 */
export function host(options: HostOptions = {}): Host {
	const store = options.store ?? memoryCanvas();
	const storage = options.storage ?? memoryJournals();
	const errors: CanvasError[] = [];
	const canvas = openCanvas({
		name: 'lab',
		runtime: createRuntime({ storage, execution: scripted(options.script ?? byAgent({})) }),
		store,
		breakout: options.breakout ?? { team: ['cy'] },
		...(options.workspace === undefined ? {} : { workspace: options.workspace }),
		onError: (error) => void errors.push(error),
	});
	onTestFinished(() => canvas.close());
	return { canvas, store, storage, errors };
}

/** The names of the agents that a room seats, and of the agents in its reserve. */
export async function membersOf(room: Room): Promise<{ seated: string[]; reserve: string[] }> {
	const read = await room.read({ messages: false });
	return {
		seated: read.participants.flatMap((p) => (p.kind === 'agent' ? [p.name] : [])),
		reserve: read.reserve.map((entry) => entry.name),
	};
}

/** The state of each row, by room name. */
export async function statesOf(store: CanvasStore): Promise<Record<string, string>> {
	return Object.fromEntries((await store.list()).map((row) => [row.name, row.state]));
}

/** The live handle of a room, or a failure that names the room. */
export function live(canvas: Canvas, name: string): Room {
	const room = canvas.room(name);
	if (room === undefined) throw new Error(`The canvas holds no live room "${name}".`);
	return room;
}
