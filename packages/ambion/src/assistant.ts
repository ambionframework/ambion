/** The room's assistant policy, pure over a composition and recorded facts. */

import { Type } from 'typebox';
import type { Message } from './types.ts';
import type { Close, Composition, Seating } from './wire.ts';

export interface AssistantPolicy {
	readonly guidance: string;
	opening(
		composition: Composition | undefined,
		roster: readonly Seating[],
		reserve: readonly Seating[],
	): string | undefined;
	closing(
		composition: Composition | undefined,
		roster: readonly Seating[],
		messages: readonly Message[],
		people: Readonly<{ has(name: string): boolean }>,
		close: Close,
	): string | undefined;
}

export const assistantPolicy: AssistantPolicy = {
	guidance:
		'You are seated in the room. Nothing said in it wakes you. You compose the room for people and write for them.',
	opening(composition, roster, reserve) {
		const assistant = assistantSeat(composition, roster);
		return assistant === undefined || reserve.length === 0 ? undefined : assistant;
	},
	closing(composition, roster, messages, people, close) {
		const assistant = assistantSeat(composition, roster);
		return assistant === undefined || !needsSummary(messages, people, assistant, close)
			? undefined
			: assistant;
	},
};

export const SEAT = {
	name: 'seat' as const,
	parameters: Type.Object({
		name: Type.String({ description: 'An agent name from the reserve.' }),
	}),
};
export const SUMMARISE = {
	name: 'summarise' as const,
	parameters: Type.Object({ text: Type.String() }),
};

export const assistantDuties = {
	[SEAT.name]: [
		`One of the people in the room has just asked a question, and the agents seated in the`,
		`room are reading it now. Seating is the seat tool: it takes one name from the reserve`,
		`listed below the agents, and puts that agent in the room, where it wakes at once and reads`,
		`the question. Seat every agent whose identity touches the question, however remotely:`,
		`what each holds, what it can check, whose call it would be. A seated agent that reads the`,
		`question and has nothing to add ends its turn without speaking, and that costs the room`,
		`one glance. A perspective that was never in the room costs the answer. When in doubt,`,
		`seat. Leave an agent in the reserve only when its identity has nothing to do with the`,
		`question at all. Call seat once per agent, and end your turn when everybody you want`,
		`is in the room.`,
		``,
		`You never speak, never answer the question, and never direct anyone. What you seat is on`,
		`the record, stamped as your doing. Nothing the agents say while you decide reaches you:`,
		`the question is what you decide on.`,
	],
	[SUMMARISE.name]: [
		`One of the people in the room asked a question, the agents worked it out between them,`,
		`and the room is quiet again. Writing is the summarise tool. Give it the one message your`,
		`person reads instead of the working: their question, answered once, for somebody who has`,
		`not read a line of it.`,
		``,
		`Answer what they asked, and nothing beside it. Keep a fact only when their answer depends`,
		`on it — a quantity, a date, an owner, a deadline, or something still unknown that decides`,
		`what they do next. Keep what changed while the room worked: a correction, a decision, a`,
		`date that moved. They did not see it happen, and it is why the answer is what it is now.`,
		`Drop everything else the room raised, however true. A fact that changes nothing for them`,
		`is noise in the one message they read.`,
		``,
		`Write the shortest message that carries the answer. Do not restate their question, do not`,
		`list what the room discussed, and never say what you left out. Leave out who said what,`,
		`and in which order. Pass the message and nothing else: no preamble, no heading, no`,
		`sign-off, and never a note about how you wrote it.`,
		``,
		`Ending your turn without calling summarise leaves the range whole, and every reader still`,
		`sees all of it. Do that when there is nothing to consolidate — when what the room said`,
		`already reads as one answer, and standing between your person and it would only add a`,
		`voice. Later messages do not change the exchange you answer. Write only the`,
		`fixed range the room gave you.`,
		``,
		`What you write is not something you said in the room. Nobody hears it, no agent wakes`,
		`because of it, and it never carries your person's name — the room stamps it as yours.`,
		`You hold their preferences; they hold the decision. You decide nothing, you act on nothing,`,
		`and you never answer in their place.`,
	],
} as const;

export function assistantAction(tool: 'seat' | 'summarise'): string {
	return tool === SEAT.name
		? 'Seat who the question needs from the reserve, or end your turn to leave the roster as it stands.'
		: 'Write the one message they read for it, or end your turn to leave the range whole.';
}

export function summaryToolDescription(person: string): string {
	return `Write the one message ${person} reads for this exchange. Call it once. Ending your turn without calling it leaves the range whole, for whoever reads it.`;
}

export const seatToolDescription =
	'Seat one agent from the reserve. It joins the room at once and reads the question. Ending your turn without calling it leaves the roster as it stands.';

export function assistantSeat(
	composition: Composition | undefined,
	roster: readonly Seating[],
): string | undefined {
	const name = composition?.assistant;
	return name !== undefined && roster.some((seat) => seat.name === name) ? name : undefined;
}

function needsSummary(
	messages: readonly Message[],
	people: Readonly<{ has(name: string): boolean }>,
	assistant: string,
	close: Close,
): boolean {
	return (
		messages.filter(
			(message) =>
				message.seq >= close.from &&
				message.seq <= close.through &&
				message.kind === 'said' &&
				!people.has(message.from) &&
				message.from !== assistant,
		).length >= 2
	);
}
