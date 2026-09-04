/**
 * The roster: who is seated in one room, and who is held in reserve.
 *
 * Both lists hold the same kind of entry, an agent and the attention it takes
 * when seated, and an agent moves between them: the assistant seats one from
 * the reserve, the host seats one from the reserve or from anywhere, and an
 * unseat returns a reserve agent to it. One name names one participant across
 * both lists and the people the room knows, and the roster refuses a second.
 *
 * What is here is the two lists and the moves between them. What a seating
 * does to the record, and what it wakes, is the room's (`session.ts`).
 */
import type { SeatRuntime } from './seat.ts';
import {
	type AgentDefinition,
	type AgentSeat,
	type Attention,
	isAgent,
	isSeatedAgent,
} from './types.ts';

/** An agent and the attention it takes when seated: what both lists hold. */
export interface Reserved {
	def: AgentDefinition;
	attention: Attention;
}

/** The definition and the attention an `AgentSeat` carries. Refuses anything else. */
export function unwrap(seat: AgentSeat): Reserved {
	const def = isSeatedAgent(seat) ? seat.agent : seat;
	if (!isAgent(def)) {
		throw new Error('Agents must come from defineAgent or seated().');
	}
	return { def, attention: isSeatedAgent(seat) ? seat.attention : 'broadcast' };
}

export class Roster {
	private readonly seats = new Map<string, SeatRuntime>();
	/** The reserve: agents the room may seat later, held with the attention they will take. */
	private readonly reserve = new Map<string, Reserved>();

	/** `taken` answers for the people the room knows: one name names one participant. */
	constructor(private readonly taken: (name: string) => boolean) {}

	/** Seat one agent, refusing a name the room already knows. */
	place(entry: Reserved): SeatRuntime {
		this.assertFreeName(entry.def.name);
		const placed: SeatRuntime = { def: entry.def, attention: entry.attention };
		this.seats.set(entry.def.name, placed);
		return placed;
	}

	/** Hold one agent in reserve, refusing a name the room already knows. */
	hold(entry: Reserved): void {
		this.assertFreeName(entry.def.name);
		this.reserve.set(entry.def.name, entry);
	}

	/** One name names one participant: seated, in reserve, or a person the room knows. */
	private assertFreeName(name: string): void {
		if (this.knows(name) || this.taken(name)) {
			throw new Error(`Duplicate agent name '${name}': one name names one participant.`);
		}
	}

	/** The host seats an agent: from the reserve when it is there, and from anywhere else too. */
	seat(seat: AgentSeat): SeatRuntime {
		const given = unwrap(seat);
		const held = this.reserve.get(given.def.name);
		if (held) this.reserve.delete(given.def.name);
		// A bare definition takes the attention its reserve entry carried.
		const attention = isSeatedAgent(seat) ? seat.attention : (held?.attention ?? 'broadcast');
		const placed = this.place({ def: given.def, attention });
		placed.added = true;
		if (held) placed.reserved = true;
		return placed;
	}

	/** The assistant seats one name from the reserve, and is refused a name that is not there. */
	admit(name: string): SeatRuntime {
		const held = this.reserve.get(name);
		if (!held) throw new Error(`'${name}' is not in the reserve.`);
		this.reserve.delete(name);
		const placed = this.place(held);
		placed.added = true;
		placed.reserved = true;
		return placed;
	}

	/** Off the roster, and a reserve agent goes back to the reserve. The activation in flight is the room's to end. */
	retire(seat: SeatRuntime): void {
		this.seats.delete(seat.def.name);
		if (seat.reserved)
			this.reserve.set(seat.def.name, { def: seat.def, attention: seat.attention });
	}

	get(name: string): SeatRuntime | undefined {
		return this.seats.get(name);
	}

	seated(): IterableIterator<SeatRuntime> {
		return this.seats.values();
	}

	/** Seated or held: a name an agent holds in this room. */
	knows(name: string): boolean {
		return this.seats.has(name) || this.reserve.has(name);
	}

	reserveSize(): number {
		return this.reserve.size;
	}

	/** The reserve as the assistant reads it: a name and an identity per agent. */
	reserved(): { name: string; identity: string }[] {
		return [...this.reserve.values()].map(({ def }) => ({
			name: def.name,
			identity: def.identity,
		}));
	}
}
