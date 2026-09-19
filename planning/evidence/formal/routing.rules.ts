/**
 * Prototype: the routing, delivery and presence rules of the room, as
 * `packages/ambion/src/room/rules.verified.ts` would hold them. Every
 * function is pure; `routing.ts`, `delivery.ts` and `presence.ts` run
 * these bodies.
 *
 * The string unions are declared again beside the rules, because
 * LemmaScript lowers only the types in its own file. `rules.test.ts`
 * asserts each copy equals the public type in `types.ts`.
 */

/** What wakes a seat. The same union as `Attention` in `types.ts`. */
export type Attention = 'none' | 'named' | 'broadcast' | 'presence';

/** Every kind of message on the record. The same union as `Message['kind']` in `types.ts`. */
export type MessageKind = 'said' | 'arrived' | 'left' | 'seated' | 'unseated' | 'summary';

/** Where an activation id came from. The same union as the `source` of `decodeActivationId`. */
export type Source = 'message' | 'closed';

/** One seat on the roster, as the routing reads it. `Seating` in `events.ts` is this plus an identity. */
export interface Seat {
	readonly name: string;
	readonly attention: Attention;
}

/** The interval a lease held, as the steer rule reads it. `LeaseHold` in `lease.ts` is this plus its facts. */
export type Hold =
	| { readonly phase: 'running'; readonly since: number }
	| { readonly phase: 'ended'; readonly since: number; readonly until: number };

//@ contract The attention scale is one total order, narrowest first: none is 0, named 1, broadcast 2, presence 3.
export function width(attention: Attention): number {
	//@ ensures 0 <= \result && \result <= 3
	//@ ensures \result == 0 <==> attention == 'none'
	//@ ensures \result == 1 <==> attention == 'named'
	//@ ensures \result == 2 <==> attention == 'broadcast'
	//@ ensures \result == 3 <==> attention == 'presence'
	if (attention === 'named') return 1;
	if (attention === 'broadcast') return 2;
	if (attention === 'presence') return 3;
	return 0;
}

//@ contract A summary reaches no seat (0), a directed say reaches the one it names (1), anything else said reaches the room (2), and a presence change reaches the widest end (3).
export function reachOf(kind: MessageKind, directed: boolean): number {
	//@ ensures 0 <= \result && \result <= 3
	//@ ensures kind == 'summary' ==> \result == 0
	//@ ensures kind == 'said' && directed ==> \result == 1
	//@ ensures kind == 'said' && !directed ==> \result == 2
	//@ ensures kind != 'said' && kind != 'summary' ==> \result == 3
	if (kind === 'summary') return 0;
	if (kind !== 'said') return 3;
	return directed ? 1 : 2;
}

//@ contract A directed say names the seat it addresses, a seating names the seat it seats, and no other message names a seat.
export function targetOf(
	kind: MessageKind,
	to: string | undefined,
	subject: string | undefined,
): string | undefined {
	//@ ensures kind == 'said' && to == undefined ==> \result == undefined
	//@ ensures kind == 'said' && to != undefined ==> \result != undefined
	//@ ensures \result != undefined && to != undefined && kind == 'said' ==> \result == to
	//@ ensures kind == 'seated' && subject != undefined ==> \result != undefined
	//@ ensures \result != undefined && subject != undefined && kind == 'seated' ==> \result == subject
	//@ ensures kind != 'said' && kind != 'seated' ==> \result == undefined
	if (kind === 'said') return to;
	if (kind === 'seated') return subject;
	return undefined;
}

//@ contract The message names this seat: it has a target, and the target is this name.
export function isNamed(target: string | undefined, name: string): boolean {
	//@ ensures target == undefined ==> !\result
	//@ ensures target != undefined ==> (\result <==> target == name)
	if (target !== undefined && target === name) return true;
	return false;
}

//@ contract This seat wrote the message. A seating the host decided has no author.
export function isAuthor(author: string | undefined, name: string): boolean {
	//@ ensures author == undefined ==> !\result
	//@ ensures author != undefined ==> (\result <==> author == name)
	if (author !== undefined && author === name) return true;
	return false;
}

//@ contract A seat the message names wakes however narrowly it is seated. Any other seat wakes only when its attention is at least as wide as the reach, and a directed say or a summary wakes no seat it does not name.
export function wakes(attention: Attention, named: boolean, reach: number): boolean {
	//@ requires 0 <= reach && reach <= 3
	//@ ensures named ==> \result
	//@ ensures !named && reach == 0 ==> !\result
	//@ ensures !named && reach == 1 ==> !\result
	//@ ensures !named && reach == 2 ==> (\result <==> (attention == 'broadcast' || attention == 'presence'))
	//@ ensures !named && reach == 3 ==> (\result <==> attention == 'presence')
	//@ ensures !named && reach >= 2 ==> (\result <==> width(attention) >= reach)
	//@ ensures !named && \result ==> width(attention) >= reach
	if (named) return true;
	if (reach === 0) return false;
	if (width(attention) < reach) return false;
	return reach !== 1;
}

//@ contract For one seat: a message never wakes its author, never wakes a seat at ordinary work, always wakes the idle seat it names, and otherwise wakes the seat exactly when the scale says so.
export function wokenBy(
	seat: Seat,
	author: string | undefined,
	target: string | undefined,
	reach: number,
	busy: boolean,
): boolean {
	//@ requires 0 <= reach && reach <= 3
	//@ ensures busy ==> !\result
	//@ ensures isAuthor(author, seat.name) ==> !\result
	//@ ensures !busy && !isAuthor(author, seat.name) && isNamed(target, seat.name) ==> \result
	//@ ensures reach == 1 && \result ==> isNamed(target, seat.name)
	//@ ensures reach == 0 && \result ==> isNamed(target, seat.name)
	//@ ensures !busy && !isAuthor(author, seat.name) ==> (\result <==> wakes(seat.attention, isNamed(target, seat.name), reach))
	if (busy) return false;
	if (isAuthor(author, seat.name)) return false;
	return wakes(seat.attention, isNamed(target, seat.name), reach);
}

//@ contract A name is held when it is among the seats at ordinary work.
export function held(busy: string[], name: string): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < busy.length && busy[i] == name)
	return busy.includes(name);
}

//@ contract A name is on the roster when some seat carries it.
export function onRoster(roster: Seat[], name: string): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < roster.length && roster[i].name == name)
	return roster.some((seat) => seat.name === name);
}

//@ contract One more name at the end, and every earlier name where it was.
export function append(names: string[], name: string): string[] {
	//@ ensures \result.length == names.length + 1
	//@ ensures \result[names.length] == name
	//@ ensures forall(i, 0 <= i && i < names.length ==> \result[i] == names[i])
	return [...names, name];
}

//@ contract Who a message wakes among the first r seats of the roster: never the author, never a seat at ordinary work, only roster names, for a directed say or a summary nobody but the target, and every seat wokenBy admits.
export function wokenUpTo(
	roster: Seat[],
	r: number,
	author: string | undefined,
	target: string | undefined,
	reach: number,
	busy: string[],
): string[] {
	//@ requires 0 <= reach && reach <= 3
	//@ requires 0 <= r && r <= roster.length
	//@ decreases r
	//@ ensures \result.length <= r
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !isAuthor(author, \result[i]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !held(busy, \result[i]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> onRoster(roster, \result[i]))
	//@ ensures reach == 1 ==> forall(i, 0 <= i && i < \result.length ==> isNamed(target, \result[i]))
	//@ ensures reach == 0 ==> forall(i, 0 <= i && i < \result.length ==> isNamed(target, \result[i]))
	//@ ensures forall(s, 0 <= s && s < r && wokenBy(roster[s], author, target, reach, held(busy, roster[s].name)) ==> exists(i, 0 <= i && i < \result.length && \result[i] == roster[s].name))
	if (r === 0) return [];
	const seat = roster[r - 1] as Seat;
	const before = wokenUpTo(roster, r - 1, author, target, reach, busy);
	if (wokenBy(seat, author, target, reach, held(busy, seat.name))) return append(before, seat.name);
	return before;
}

//@ contract Who a message wakes on the roster: never the author, never a seat at ordinary work, only roster names, for a directed say or a summary nobody but the target, and every seat wokenBy admits.
export function woken(
	roster: Seat[],
	author: string | undefined,
	target: string | undefined,
	reach: number,
	busy: string[],
): string[] {
	//@ requires 0 <= reach && reach <= 3
	//@ ensures \result.length <= roster.length
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !isAuthor(author, \result[i]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !held(busy, \result[i]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> onRoster(roster, \result[i]))
	//@ ensures reach == 1 ==> forall(i, 0 <= i && i < \result.length ==> isNamed(target, \result[i]))
	//@ ensures reach == 0 ==> forall(i, 0 <= i && i < \result.length ==> isNamed(target, \result[i]))
	//@ ensures forall(s, 0 <= s && s < roster.length && wokenBy(roster[s], author, target, reach, held(busy, roster[s].name)) ==> exists(i, 0 <= i && i < \result.length && \result[i] == roster[s].name))
	return wokenUpTo(roster, roster.length, author, target, reach, busy);
}

//@ contract The room changes before the message does: a seating's newcomer is on the roster the routing reads, at the attention the seating names or broadcast when it names none, and every existing seat is unchanged.
export function rosterFor(
	roster: Seat[],
	seated: boolean,
	subject: string,
	attention: Attention | undefined,
): Seat[] {
	//@ ensures !seated ==> \result == roster
	//@ ensures seated ==> \result.length == roster.length + 1
	//@ ensures seated ==> \result[roster.length].name == subject
	//@ ensures seated && attention == undefined ==> \result[roster.length].attention == 'broadcast'
	//@ ensures seated && attention != undefined ==> \result[roster.length].attention == attention
	//@ ensures forall(i, 0 <= i && i < roster.length ==> \result[i] == roster[i])
	if (!seated) return roster;
	return [...roster, { name: subject, attention: attention !== undefined ? attention : 'broadcast' }];
}

//@ contract A lease was at work when a message landed: it held a change before the message, and ended, if it ended, at or after it.
export function atWorkHold(hold: Hold, seq: number): boolean {
	//@ ensures \result ==> hold.since < seq
	//@ ensures hold.phase == 'running' ==> (\result <==> hold.since < seq)
	//@ ensures hold.phase == 'ended' ==> (\result <==> (hold.since < seq && seq <= hold.until))
	if (hold.phase === 'running') return hold.since < seq;
	return hold.since < seq && seq <= hold.until;
}

//@ contract A message steers an ordinary lease that was at work when the message landed, and never the author's seat, a seat the message wakes, or a closing lease.
export function steers(
	source: Source,
	seat: string,
	author: string | undefined,
	woken: boolean,
	hold: Hold,
	seq: number,
): boolean {
	//@ ensures \result ==> source == 'message'
	//@ ensures \result ==> !woken
	//@ ensures isAuthor(author, seat) ==> !\result
	//@ ensures \result ==> atWorkHold(hold, seq)
	//@ ensures source == 'message' && !woken && !isAuthor(author, seat) && atWorkHold(hold, seq) ==> \result
	if (source !== 'message') return false;
	if (woken) return false;
	if (isAuthor(author, seat)) return false;
	return atWorkHold(hold, seq);
}

/** A person is in the room or they are not. The same union as `PresenceStatus` in `types.ts`. */
export type Presence = 'present' | 'absent';

/** One person the record knows. The same fields as `PersonState` in `presence.ts`. */
export interface Person {
	readonly name: string;
	readonly identity: string;
	readonly presence: Presence;
	readonly since: number | undefined;
	readonly changedAt: string | undefined;
	readonly preferences: string | undefined;
}

/** One message projected to what the presence fold reads. */
export interface PresenceEntry {
	readonly kind: MessageKind;
	readonly name: string;
	readonly seq: number;
	readonly at: string;
	readonly identity: string | undefined;
	readonly preferences: string | undefined;
}

//@ contract A known person is present when the record says so; an unknown name is not present.
export function present(person: Person | undefined): boolean {
	//@ ensures person == undefined ==> !\result
	//@ ensures person != undefined ==> (\result <==> person.presence == 'present')
	if (person !== undefined && person.presence === 'present') return true;
	return false;
}

//@ contract An arrival makes a person present. It keeps the cursor of their last departure, and keeps their identity and preferences unless the arrival carries them.
export function arrive(known: Person | undefined, entry: PresenceEntry): Person {
	//@ ensures \result.presence == 'present'
	//@ ensures \result.name == entry.name
	//@ ensures \result.changedAt == entry.at
	//@ ensures known != undefined ==> \result.since == known.since
	//@ ensures known == undefined ==> \result.since == undefined
	//@ ensures entry.identity != undefined ==> \result.identity == entry.identity
	//@ ensures known != undefined && entry.identity == undefined ==> \result.identity == known.identity
	//@ ensures known == undefined && entry.identity == undefined ==> \result.identity == ''
	//@ ensures entry.preferences != undefined ==> \result.preferences == entry.preferences
	//@ ensures known != undefined && entry.preferences == undefined ==> \result.preferences == known.preferences
	//@ ensures known == undefined && entry.preferences == undefined ==> \result.preferences == undefined
	return {
		name: entry.name,
		identity:
			entry.identity !== undefined ? entry.identity : known !== undefined ? known.identity : '',
		presence: 'present',
		since: known !== undefined ? known.since : undefined,
		changedAt: entry.at,
		preferences:
			entry.preferences !== undefined
				? entry.preferences
				: known !== undefined
					? known.preferences
					: undefined,
	};
}

//@ contract A departure makes a known person absent at its seq and keeps their identity and preferences. A departure of an unknown name records nothing.
export function depart(known: Person | undefined, entry: PresenceEntry): Person | undefined {
	//@ ensures known == undefined ==> \result == undefined
	//@ ensures known != undefined ==> \result != undefined
	//@ ensures \result != undefined ==> \result.presence == 'absent'
	//@ ensures \result != undefined ==> \result.name == entry.name
	//@ ensures \result != undefined ==> \result.since == entry.seq
	//@ ensures \result != undefined ==> \result.changedAt == entry.at
	//@ ensures \result != undefined && known != undefined ==> \result.identity == known.identity
	//@ ensures \result != undefined && known != undefined ==> \result.preferences == known.preferences
	if (known === undefined) return undefined;
	return {
		name: entry.name,
		identity: known.identity,
		presence: 'absent',
		since: entry.seq,
		changedAt: entry.at,
		preferences: known.preferences,
	};
}

//@ contract One presence entry applied to one person. An arrival makes the person present, keeps their last-departure cursor, and keeps their identity unless the arrival carries one. A departure makes a known person absent at its seq and keeps identity and preferences. A departure of an unknown name and every other kind record nothing.
export function stepPerson(known: Person | undefined, entry: PresenceEntry): Person | undefined {
	//@ ensures entry.kind == 'arrived' ==> \result != undefined
	//@ ensures entry.kind == 'arrived' ==> present(\result)
	//@ ensures entry.kind == 'left' ==> !present(\result)
	//@ ensures entry.kind == 'left' && known == undefined ==> \result == undefined
	//@ ensures entry.kind == 'left' && known != undefined ==> \result != undefined
	//@ ensures entry.kind != 'arrived' && entry.kind != 'left' ==> (present(\result) <==> present(known))
	//@ ensures \result != undefined && (entry.kind == 'arrived' || entry.kind == 'left') ==> \result.name == entry.name
	//@ ensures \result != undefined && (entry.kind == 'arrived' || entry.kind == 'left') ==> \result.changedAt == entry.at
	//@ ensures \result != undefined && entry.kind == 'left' ==> \result.since == entry.seq
	//@ ensures \result != undefined && known != undefined && entry.kind == 'arrived' ==> \result.since == known.since
	//@ ensures \result != undefined && known == undefined && entry.kind == 'arrived' ==> \result.since == undefined
	//@ ensures \result != undefined && entry.identity != undefined && entry.kind == 'arrived' ==> \result.identity == entry.identity
	//@ ensures \result != undefined && known != undefined && entry.identity == undefined && entry.kind == 'arrived' ==> \result.identity == known.identity
	//@ ensures \result != undefined && known != undefined && entry.kind == 'left' ==> \result.identity == known.identity
	//@ ensures \result != undefined && known != undefined && entry.kind == 'left' ==> \result.preferences == known.preferences
	if (entry.kind === 'arrived') return arrive(known, entry);
	if (entry.kind === 'left') return depart(known, entry);
	return known;
}

//@ contract Every person the record knows: a name is known once it arrived, and a known name is present exactly when its last presence entry is an arrival.
export function foldPresence(entries: PresenceEntry[]): Map<string, Person> {
	//@ ensures forall(n: string, \result.has(n) ==> (present(\result.get(n)) <==> exists(k, 0 <= k && k < entries.length && entries[k].name == n && entries[k].kind == 'arrived' && forall(j, k < j && j < entries.length && entries[j].name == n ==> entries[j].kind != 'left'))))
	//@ ensures forall(k, 0 <= k && k < entries.length && entries[k].kind == 'arrived' ==> \result.has(entries[k].name))
	const people: Map<string, Person> = new Map();
	for (let i = 0; i < entries.length; i++) {
		//@ invariant 0 <= i && i <= entries.length
		//@ invariant forall(n: string, people.has(n) ==> (present(people.get(n)) <==> exists(k, 0 <= k && k < i && entries[k].name == n && entries[k].kind == 'arrived' && forall(j, k < j && j < i && entries[j].name == n ==> entries[j].kind != 'left'))))
		//@ invariant forall(k, 0 <= k && k < i && entries[k].kind == 'arrived' ==> people.has(entries[k].name))
		const entry = entries[i] as PresenceEntry;
		const next = stepPerson(people.get(entry.name), entry);
		if (next !== undefined) people.set(entry.name, next);
	}
	return people;
}
