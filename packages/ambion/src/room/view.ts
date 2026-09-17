/** Pure collaboration context derived from the room projection. */

import type {
	ActivationPurpose,
	ActivationSpec,
	ActivationView,
	CollaborationContext,
	ContextParticipant,
} from '../protocol.ts';
import type { AgentParticipantInfo, Message, ParticipantInfo, Seq, TaskView } from '../types.ts';
import type { RoomState } from './fold.ts';
import { taskContext } from './tasks.ts';

/** What the view is built from: the fold and current host facts. */
export interface RoomFacts {
	readonly name: string;
	readonly now: number;
	readonly state: RoomState;
	/** The seats live now, by name, with the ids that make them live. */
	readonly live: ReadonlyMap<string, string[]>;
	/** How many messages landed after this seq. */
	unseen(since: Seq): number;
}

/** The roster and people returned by the public participants query. */
export function participantsOf(facts: Pick<RoomFacts, 'state' | 'live'>): ParticipantInfo[] {
	return [
		...agentsOf(facts),
		...[...facts.state.people.values()].map((person) => ({
			kind: 'human' as const,
			name: person.name,
			identity: person.identity,
			presence: person.presence,
		})),
	];
}

function agentsOf(facts: Pick<RoomFacts, 'state' | 'live'>): AgentParticipantInfo[] {
	return facts.state.roster.map((seat) => ({
		kind: 'agent',
		name: seat.name,
		identity: seat.identity,
		status: facts.live.has(seat.name) ? 'active' : 'idle',
		attention: seat.attention,
	}));
}

/** Select collaboration facts without reading an executable agent definition. */
export function viewOf(spec: ActivationSpec, facts: RoomFacts): ActivationView {
	const state = facts.state;
	const purpose = spec.purpose;
	const goal = state.composition?.goal;
	const messages =
		purpose.kind === 'summarize'
			? state.messages.filter(
					(message) => message.seq >= purpose.exchange && message.seq <= purpose.through,
				)
			: state.messages;
	const context: CollaborationContext = {
		name: facts.name,
		now: facts.now,
		...(goal === undefined ? {} : { goal }),
		participants: [...agentsOf(facts), ...peopleOf(facts)],
		messages: messages.map(contextMessage),
		tasks: visibleTasks(spec, facts).map((task) => taskContext(task, facts.name)),
		reserve: state.reserve.map(({ name, identity }) => ({ name, identity })),
		...(purpose.kind !== 'respond' || state.exchange === undefined
			? {}
			: { exchange: { owner: state.exchange.owner, from: state.exchange.from } }),
		...purposeContext(purpose, state),
	};
	// In-process executors receive the same detached snapshot as remote executors.
	return structuredClone({
		spec,
		through: purpose.kind === 'summarize' ? purpose.through : state.lastSeq,
		context,
	});
}

/** Select only the Tasks this activation is entitled to carry in context. */
function visibleTasks(spec: ActivationSpec, facts: RoomFacts): TaskView[] {
	const purpose = spec.purpose;
	const tasks = [...(facts.state.tasks ?? new Map<string, TaskView>()).values()];
	if (purpose.kind === 'summarize')
		return tasks.filter(
			(task) =>
				task.originRoom === facts.name &&
				task.exchange === purpose.exchange &&
				task.owner === spec.seat,
		);
	if (facts.state.composition?.taskScope !== undefined)
		return tasks.filter((task) => task.workingRoom === facts.name);
	const exchange = facts.state.exchange?.from;
	if (exchange === undefined) return [];
	return tasks.filter(
		(task) =>
			task.originRoom === facts.name && task.exchange === exchange && task.owner === spec.seat,
	);
}

/** Reading preferences enter context only through the recipient's summary purpose. */
function contextMessage(message: Message): Message {
	const publicMessage = { ...message };
	if ('preferences' in publicMessage) delete publicMessage.preferences;
	if (publicMessage.kind === 'said') {
		delete publicMessage.taskSnapshot;
		delete publicMessage.taskCrossRoom;
		delete publicMessage.taskNotice;
	}
	return publicMessage;
}

/** Only the summary purpose receives reading preferences. */
function purposeContext(
	purpose: ActivationPurpose,
	state: RoomState,
): Pick<CollaborationContext, 'preferences'> {
	const preferences =
		purpose.kind === 'summarize' ? state.people.get(purpose.person)?.preferences : undefined;
	return preferences === undefined ? {} : { preferences };
}

/** Public human facts and recorded reading progress, without private preferences. */
function peopleOf(facts: RoomFacts): Extract<ContextParticipant, { kind: 'human' }>[] {
	return [...facts.state.people.values()].map((person) => ({
		kind: 'human',
		name: person.name,
		identity: person.identity,
		presence: person.presence,
		...(person.changedAt === undefined ? {} : { changedAt: person.changedAt }),
		...(person.since === undefined ? {} : { since: person.since }),
		unseen: person.since === undefined ? 0 : facts.unseen(person.since),
	}));
}
