/**
 * Who is in the room, and where each of them stopped reading.
 *
 * The record says who arrived and who left; this holds the one fact a replay
 * cannot rebuild — who is here *now* — and reads everything else off the
 * record. A person is in the room or they are not: one name, one visit.
 */
import type { PersonView } from './render.ts';
import type {
	HumanDefinition,
	Message,
	Participant,
	PresenceMessage,
	PresenceStatus,
	Seq,
	Visit,
} from './types.ts';

/** One person in the room, for as long as they are in it. */
export interface VisitRuntime {
	human: HumanDefinition;
	gone: boolean;
}

/** What a visit's handle needs of the room: a delivery routed, and a departure on the record. */
export interface VisitRoom {
	deliver(from: string, input: { to?: Participant; text: string }): Promise<void>;
	/** The person is gone: the room says so on the record. */
	left(name: string): Promise<void>;
}

/**
 * Who is in the room, and where each of them stopped reading. The record is
 * the store. This holds the one fact a replay cannot rebuild: who is here
 * now. Everything else it answers, it reads off the record.
 */
export class Attendance {
	private readonly inRoom = new Map<string, VisitRuntime>();

	constructor(private readonly record: () => readonly Message[]) {}

	enter(human: HumanDefinition): VisitRuntime {
		const visit: VisitRuntime = { human, gone: false };
		this.inRoom.set(human.name, visit);
		return visit;
	}

	leave(name: string): void {
		this.inRoom.delete(name);
	}

	visitOf(name: string): VisitRuntime | undefined {
		return this.inRoom.get(name);
	}

	all(): VisitRuntime[] {
		return [...this.inRoom.values()];
	}

	/** The handle a person holds while they are here. It refuses a delivery once they have left. */
	handle(visit: VisitRuntime, room: VisitRoom): Visit {
		const name = visit.human.name;
		const here = this;
		return {
			human: visit.human,
			get since() {
				return here.sinceOf(name);
			},
			async deliver(input) {
				if (visit.gone) throw new Error(`${name}'s visit has ended.`);
				await room.deliver(name, input);
			},
			async leave() {
				if (visit.gone) return;
				visit.gone = true;
				here.leave(name);
				await room.left(name);
			},
		};
	}

	/** One entry per person the room knows, with their gap and what they missed. */
	views(unseen: (since: Seq) => number): PersonView[] {
		const views: PersonView[] = [];
		for (const [name, identity] of this.known()) {
			const since = this.sinceOf(name);
			views.push({
				name,
				identity,
				presence: this.presenceOf(name),
				changedAt: this.lastChangeAt(name),
				since,
				unseen: since === undefined ? 0 : unseen(since),
			});
		}
		return views;
	}

	presenceOf(name: string): PresenceStatus {
		return this.inRoom.has(name) ? 'present' : 'absent';
	}

	/** Every person the room knows: the arrivals on the record, and who is here. */
	known(): Map<string, string> {
		const known = new Map<string, string>();
		for (const message of this.record()) {
			if (message.kind !== 'arrived') continue;
			known.set(message.from, message.identity ?? '');
		}
		for (const visit of this.inRoom.values()) known.set(visit.human.name, visit.human.identity);
		return known;
	}

	knows(name: string): boolean {
		return this.known().has(name);
	}

	/** The seq of this person's last `left`, or undefined before their first. */
	sinceOf(name: string): Seq | undefined {
		return this.lastPresence(name)?.seq;
	}

	/** When this person's presence last changed, ISO. */
	lastChangeAt(name: string): string | undefined {
		const record = this.record();
		for (let i = record.length - 1; i >= 0; i -= 1) {
			const message = record[i];
			if (message && message.kind !== 'said' && message.from === name) return message.at;
		}
		return undefined;
	}

	private lastPresence(name: string): PresenceMessage | undefined {
		const record = this.record();
		for (let i = record.length - 1; i >= 0; i -= 1) {
			const message = record[i];
			if (message?.kind === 'left' && message.from === name) return message;
		}
		return undefined;
	}
}
