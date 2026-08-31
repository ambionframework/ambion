/**
 * Who is in the room, and where each of them stopped reading.
 *
 * The record says who arrived and who left; this holds the one fact a replay
 * cannot rebuild — who is here *now* — and reads everything else off the
 * record. A person is in the room or they are not: one name, one visit.
 */
import type { HumanDefinition, Message, PresenceMessage, PresenceStatus, Seq } from './types.ts';

/** One person in the room, for as long as they are in it. */
export interface VisitRuntime {
	human: HumanDefinition;
	gone: boolean;
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
