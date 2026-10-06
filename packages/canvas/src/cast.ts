/**
 * What each room receives: the definitions that its row names. A function
 * here reads a row and the definitions of the host, and starts nothing.
 */
import { type AgentDefinition, AmbionError, type StartRoomOptions } from '@ambionframework/ambion';
import type { BreakoutStart, CanvasRoom, RootStart } from './store.ts';
import type { CanvasRoomOptions } from './types.ts';

/** The definitions that `resume` took, and the worker team. */
export interface Definitions {
	readonly byName: ReadonlyMap<string, AgentDefinition>;
	readonly team: ReadonlySet<string>;
}

/** The options of `startRoom` that a row decides, and the definitions that `resumeRoom` needs. */
export interface Cast {
	readonly start: Pick<
		StartRoomOptions,
		'agents' | 'assistant' | 'seats' | 'summaryWriter' | 'seating'
	>;
	readonly members: readonly AgentDefinition[];
}

/** The refusal for a call that the rules of the canvas forbid. */
export const refuse = (message: string): AmbionError => new AmbionError('refused', message);

/** Index the definitions by name, and refuse a team name that no definition resolves. */
export function definitionsOf(
	agents: readonly AgentDefinition[],
	team: readonly string[],
): Definitions {
	const byName = new Map<string, AgentDefinition>();
	for (const agent of agents) {
		if (byName.has(agent.name))
			throw refuse(`The definitions hold the name "${agent.name}" twice.`);
		byName.set(agent.name, agent);
	}
	for (const name of team)
		if (!byName.has(name))
			throw refuse(`The worker team names "${name}", and no definition has it.`);
	return { byName, team: new Set(team) };
}

function pick(definitions: Definitions, name: string, role: string): AgentDefinition {
	const found = definitions.byName.get(name);
	if (found === undefined) throw refuse(`No definition resolves the ${role} "${name}".`);
	return found;
}

/** Refuse a team name in the agents, the seats, the assistant, or the summary writer. */
export function assertNoTeam(options: CanvasRoomOptions, team: ReadonlySet<string>): void {
	const named: [string, string | undefined][] = [
		...(options.agents ?? []).map((name): [string, string] => ['agents', name]),
		...Object.keys(options.seats ?? {}).map((name): [string, string] => ['seats', name]),
		['assistant', options.assistant],
		['summaryWriter', options.summaryWriter],
	];
	for (const [role, name] of named)
		if (name !== undefined && team.has(name))
			throw refuse(`"${name}" belongs to the worker team and cannot go in ${role}.`);
}

/** The definitions of a root room, by name: its agents, the summary writer, and the assistant. */
function rootMembers(
	start: RootStart,
	definitions: Definitions,
	assistant: AgentDefinition | undefined,
): Map<string, AgentDefinition> {
	const names =
		start.agents ?? [...definitions.byName.keys()].filter((name) => !definitions.team.has(name));
	const members = new Map<string, AgentDefinition>();
	for (const name of names) members.set(name, pick(definitions, name, 'agent'));
	if (start.summaryWriter !== undefined)
		members.set(start.summaryWriter, pick(definitions, start.summaryWriter, 'summary writer'));
	if (assistant !== undefined) members.set(assistant.name, assistant);
	return members;
}

/** The cast of a root room. The assistant joins through `assistant`, never through `agents`. */
function rootCast(start: RootStart, definitions: Definitions): Cast {
	const assistant =
		start.assistant === undefined ? undefined : pick(definitions, start.assistant, 'assistant');
	const members = rootMembers(start, definitions, assistant);
	return {
		start: {
			agents: [...members.values()].filter((agent) => agent.name !== assistant?.name),
			...(assistant === undefined ? {} : { assistant }),
			...(start.summaryWriter === undefined ? {} : { summaryWriter: start.summaryWriter }),
			...(start.seats === undefined ? {} : { seats: start.seats }),
			...(start.seating === undefined ? {} : { seating: start.seating }),
		},
		members: [...members.values()],
	};
}

/** The cast of a breakout room: its workers at `broadcast`, no assistant, no reserve, no seating. */
function breakoutCast(start: BreakoutStart, definitions: Definitions): Cast {
	const members = start.agents.map((name) => pick(definitions, name, 'agent'));
	return {
		start: {
			agents: members,
			seats: Object.fromEntries(members.map((agent) => [agent.name, 'broadcast' as const])),
			seating: false,
		},
		members,
	};
}

export function castOf(row: CanvasRoom, definitions: Definitions): Cast {
	return row.start.kind === 'root'
		? rootCast(row.start, definitions)
		: breakoutCast(row.start, definitions);
}

/** The root start that `open` records: the options that the caller gave, and no other. */
export function rootStartOf(options: CanvasRoomOptions): RootStart {
	return {
		kind: 'root',
		...(options.agents === undefined ? {} : { agents: options.agents }),
		...(options.seats === undefined ? {} : { seats: options.seats }),
		...(options.assistant === undefined ? {} : { assistant: options.assistant }),
		...(options.summaryWriter === undefined ? {} : { summaryWriter: options.summaryWriter }),
		...(options.seating === undefined ? {} : { seating: options.seating }),
	};
}
