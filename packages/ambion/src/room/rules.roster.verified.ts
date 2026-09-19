/**
 * The routing, presence, and roster rules of the room, as functions
 * LemmaScript checks. `routing.ts`, `delivery.ts`, `presence.ts`,
 * `fold.ts`, and `transition.ts` run these bodies. The proofs file beside
 * this one carries the roster induction and the routing lemmas.
 *
 * The unions and records below are declared again beside the rules,
 * because LemmaScript lowers only the types in its own file, and Dafny
 * has no structural subtyping: `Seat` is what the routing reads of a
 * seating, and `Seating` is the whole seating the roster keeps.
 * `rules.test.ts` pins each copy to the public type.
 */

/** What wakes a seat. The same union as `Attention` in `types.ts`. */
export type Attention = 'none' | 'named' | 'broadcast' | 'presence';

/** Every kind of message on the record. The same union as `Message['kind']` in `types.ts`. */
export type MessageKind = 'said' | 'arrived' | 'left' | 'seated' | 'unseated' | 'summary';

/** One seat on the roster, as the routing reads it. `Seating` in `events.ts` is this plus an identity. */
export interface Seat {
	readonly name: string;
	readonly attention: Attention;
}

//@ contract The attention scale is one total order, narrowest first: none is 0, named 1, broadcast 2, presence 3.
function width(attention: Attention): number {
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

//@ contract A summary reaches no seat (0), a directed say reaches the one it names (1), anything else said reaches the room (2), and a presence change or a seating reaches the widest end (3).
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
function isNamed(target: string | undefined, name: string): boolean {
	//@ ensures target == undefined ==> !\result
	//@ ensures target != undefined ==> (\result <==> target == name)
	if (target !== undefined && target === name) return true;
	return false;
}

//@ contract This seat wrote the message. A seating the host decided has no author.
function isAuthor(author: string | undefined, name: string): boolean {
	//@ ensures author == undefined ==> !\result
	//@ ensures author != undefined ==> (\result <==> author == name)
	if (author !== undefined && author === name) return true;
	return false;
}

//@ contract A seat the message names wakes however narrowly it is seated. Any other seat wakes only when its attention is at least as wide as the reach, and a directed say or a summary wakes no seat it does not name.
function wakes(attention: Attention, named: boolean, reach: number): boolean {
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
function wokenBy(
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
function held(busy: string[], name: string): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < busy.length && busy[i] == name)
	return busy.includes(name);
}

//@ contract A name is on the roster when some seat carries it.
export function onRoster(roster: readonly Seat[], name: string): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < roster.length && roster[i].name == name)
	return roster.some((seat) => seat.name === name);
}

//@ contract One more name at the end, and every earlier name where it was.
function append(names: string[], name: string): string[] {
	//@ ensures \result.length == names.length + 1
	//@ ensures \result[names.length] == name
	//@ ensures forall(i, 0 <= i && i < names.length ==> \result[i] == names[i])
	return [...names, name];
}

//@ contract Who a message wakes among the first r seats of the roster: never the author, never a seat at ordinary work, only roster names, and for a directed say or a summary nobody but the target. `WokenUpToComplete` in the proofs file proves that every seat wokenBy admits is woken.
function wokenUpTo(
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
	if (r === 0) return [];
	const seat = roster[r - 1] as Seat;
	const before = wokenUpTo(roster, r - 1, author, target, reach, busy);
	if (wokenBy(seat, author, target, reach, held(busy, seat.name))) return append(before, seat.name);
	return before;
}

//@ contract Who a message wakes on the roster. `WokenIsExact` in the proofs file states what it answers: never the author, never a seat at ordinary work, only roster names, for a directed say or a summary nobody but the target, and every seat wokenBy admits.
export function woken(
	roster: Seat[],
	author: string | undefined,
	target: string | undefined,
	reach: number,
	busy: string[],
): string[] {
	//@ requires 0 <= reach && reach <= 3
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
	return [
		...roster,
		{ name: subject, attention: attention !== undefined ? attention : 'broadcast' },
	];
}

//@ contract A lease was at work when a message landed: it held a change before the message, and ended, if it ended, after it. A message heard at work is one the lease covers.
function atWork(since: number, ended: boolean, until: number, seq: number): boolean {
	//@ ensures \result ==> since < seq
	//@ ensures \result && ended ==> until >= seq
	//@ ensures !ended ==> (\result <==> since < seq)
	//@ ensures !\result ==> seq <= since || (ended && until < seq)
	return since < seq && (!ended || until >= seq);
}

//@ contract A message steers an ordinary lease that was at work when the message landed, and never the author's seat, a seat the message wakes, or a closing lease.
export function steers(
	ordinary: boolean,
	seat: string,
	author: string | undefined,
	woken: boolean,
	since: number,
	ended: boolean,
	until: number,
	seq: number,
): boolean {
	//@ ensures \result ==> ordinary
	//@ ensures \result ==> !woken
	//@ ensures isAuthor(author, seat) ==> !\result
	//@ ensures \result ==> atWork(since, ended, until, seq)
	//@ ensures ordinary && !woken && !isAuthor(author, seat) && atWork(since, ended, until, seq) ==> \result
	if (!ordinary) return false;
	if (woken) return false;
	if (isAuthor(author, seat)) return false;
	return atWork(since, ended, until, seq);
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

//@ contract An arrival keeps the identity it carries, or the one the record knows, or none.
function identityOn(known: Person | undefined, identity: string | undefined): string {
	//@ ensures identity != undefined ==> \result == identity
	//@ ensures known != undefined && identity == undefined ==> \result == known.identity
	//@ ensures known == undefined && identity == undefined ==> \result == ''
	if (identity !== undefined) return identity;
	if (known !== undefined) return known.identity;
	return '';
}

//@ contract An arrival keeps the preferences it carries, or the ones the record knows, or none.
function preferencesOn(
	known: Person | undefined,
	preferences: string | undefined,
): string | undefined {
	//@ ensures preferences != undefined ==> \result == preferences
	//@ ensures known != undefined && preferences == undefined ==> \result == known.preferences
	//@ ensures known == undefined && preferences == undefined ==> \result == undefined
	if (preferences !== undefined) return preferences;
	if (known !== undefined) return known.preferences;
	return undefined;
}

//@ contract An arrival makes a person present. It keeps the cursor of their last departure, and keeps their identity and preferences unless the arrival carries them.
function arrive(known: Person | undefined, entry: PresenceEntry): Person {
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
		identity: identityOn(known, entry.identity),
		presence: 'present',
		since: known !== undefined ? known.since : undefined,
		changedAt: entry.at,
		preferences: preferencesOn(known, entry.preferences),
	};
}

//@ contract A departure makes a known person absent at its seq and keeps their identity and preferences. A departure of an unknown name records nothing.
function depart(known: Person | undefined, entry: PresenceEntry): Person | undefined {
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
function stepPerson(known: Person | undefined, entry: PresenceEntry): Person | undefined {
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

/** One seat as the roster and the reserve list it. The same shape as `Seating` in `events.ts`. */
export interface Seating {
	readonly name: string;
	readonly identity: string;
	readonly attention: Attention;
}

//@ contract A name is on the roster when a seat carries it. This is `onRoster` over a full seating: Dafny has no structural subtyping.
function carries(roster: readonly Seating[], name: string): boolean {
	//@ ensures \result <==> exists(k, 0 <= k && k < roster.length && roster[k].name == name)
	return roster.some((seat) => seat.name === name);
}

//@ contract A seat comes from the catalog when a catalog seat has its name and identity.
// biome-ignore lint/correctness/noUnusedVariables: the contract of `reserveOf` names it, and Dafny reads it there.
function fromCatalog(catalog: readonly Seating[], seat: Seating): boolean {
	//@ ensures \result <==> exists(k, 0 <= k && k < catalog.length && catalog[k].name == seat.name && catalog[k].identity == seat.identity)
	return catalog.some((held) => held.name === seat.name && held.identity === seat.identity);
}

//@ contract A catalog seat as the reserve lists it: the same name and identity, at broadcast attention.
function atBroadcast(seat: Seating): Seating {
	//@ ensures \result.name == seat.name
	//@ ensures \result.identity == seat.identity
	//@ ensures \result.attention == 'broadcast'
	return { name: seat.name, identity: seat.identity, attention: 'broadcast' };
}

//@ contract The reserve holds every catalog seat whose name is not on the roster, with its catalog identity at broadcast attention: the reserve and the roster are disjoint, every reserve seat comes from the catalog, and every catalog name is on one of them.
export function reserveOf(catalog: readonly Seating[], roster: readonly Seating[]): Seating[] {
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !carries(roster, \result[i].name))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> \result[i].attention == 'broadcast')
	//@ ensures forall(i, 0 <= i && i < \result.length ==> fromCatalog(catalog, \result[i]))
	//@ ensures forall(k, 0 <= k && k < catalog.length ==> carries(roster, catalog[k].name) || exists(i, 0 <= i && i < \result.length && \result[i].name == catalog[k].name && \result[i].identity == catalog[k].identity))
	//@ ensures \result.length <= catalog.length
	const out: Seating[] = [];
	for (let i = 0; i < catalog.length; i++) {
		//@ invariant 0 <= i && i <= catalog.length
		//@ invariant out.length <= i
		//@ invariant forall(m, 0 <= m && m < out.length ==> !carries(roster, out[m].name))
		//@ invariant forall(m, 0 <= m && m < out.length ==> out[m].attention == 'broadcast')
		//@ invariant forall(m, 0 <= m && m < out.length ==> fromCatalog(catalog, out[m]))
		//@ invariant forall(k, 0 <= k && k < i ==> carries(roster, catalog[k].name) || exists(m, 0 <= m && m < out.length && out[m].name == catalog[k].name && out[m].identity == catalog[k].identity))
		const head = catalog[i] ?? { name: '', identity: '', attention: 'broadcast' };
		if (!carries(roster, head.name)) {
			//@ ghost let before = out
			out.push(atBroadcast(head));
			//@ assert forall(m, 0 <= m && m < before.length ==> out[m] == before[m])
			//@ assert out[before.length].name == head.name && out[before.length].identity == head.identity
		}
	}
	return out;
}

/** What one message does to the roster: a seating, an unseating, or nothing. */
export type Membership =
	| {
			readonly kind: 'seated';
			readonly name: string;
			readonly identity: string;
			readonly attention: Attention;
	  }
	| { readonly kind: 'unseated'; readonly name: string }
	| { readonly kind: 'other' };

//@ contract Every seat but the named one, in record order: nothing with the name remains, every other seat stays, nothing else appears, and one seat per name is kept.
function without(roster: readonly Seating[], name: string): Seating[] {
	//@ ensures forall(i, 0 <= i && i < \result.length ==> \result[i].name != name)
	//@ ensures forall(i, 0 <= i && i < \result.length ==> roster.includes(\result[i]))
	//@ ensures forall(k, 0 <= k && k < roster.length && roster[k].name != name ==> exists(i, 0 <= i && i < \result.length && \result[i] == roster[k]))
	//@ ensures forall(i, forall(j, 0 <= i && i < j && j < roster.length ==> roster[i].name != roster[j].name)) ==> forall(i, forall(j, 0 <= i && i < j && j < \result.length ==> \result[i].name != \result[j].name))
	//@ ensures \result.length <= roster.length
	const out: Seating[] = [];
	for (let i = 0; i < roster.length; i++) {
		//@ invariant 0 <= i && i <= roster.length
		//@ invariant out.length <= i
		//@ invariant forall(m, 0 <= m && m < out.length ==> out[m].name != name)
		//@ invariant forall(m, 0 <= m && m < out.length ==> exists(k, 0 <= k && k < i && roster[k] == out[m]))
		//@ invariant forall(m, 0 <= m && m < out.length ==> roster.includes(out[m]))
		//@ invariant forall(k, 0 <= k && k < i && roster[k].name != name ==> exists(m, 0 <= m && m < out.length && out[m] == roster[k]))
		//@ invariant forall(a, forall(b, 0 <= a && a < b && b < roster.length ==> roster[a].name != roster[b].name)) ==> forall(m, forall(n, 0 <= m && m < n && n < out.length ==> out[m].name != out[n].name))
		const head = roster[i] ?? { name: '', identity: '', attention: 'broadcast' };
		if (head.name !== name) {
			//@ ghost let before = out
			out.push(head);
			//@ assert forall(m, 0 <= m && m < before.length ==> out[m] == before[m])
			//@ assert out[before.length] == head
		}
	}
	return out;
}

//@ contract One seating or unseating applied to the roster; any other message changes nothing. A seated name is on the roster once, at the end, with the message's identity and attention; an unseated name is gone; every other seat stays; nothing else appears; one seat per name is kept.
function reseated(roster: readonly Seating[], change: Membership): Seating[] {
	//@ ensures change.kind == 'other' ==> \result == roster
	//@ ensures change.kind == 'unseated' ==> !carries(\result, change.name)
	//@ ensures change.kind == 'seated' ==> \result.length >= 1 && \result[\result.length - 1].name == change.name && \result[\result.length - 1].identity == change.identity && \result[\result.length - 1].attention == change.attention
	//@ ensures change.kind == 'seated' ==> forall(i, 0 <= i && i < \result.length - 1 ==> \result[i].name != change.name)
	//@ ensures change.kind != 'other' ==> forall(i, 0 <= i && i < \result.length && \result[i].name != change.name ==> roster.includes(\result[i]))
	//@ ensures change.kind != 'other' ==> forall(k, 0 <= k && k < roster.length && roster[k].name != change.name ==> exists(i, 0 <= i && i < \result.length && \result[i] == roster[k]))
	//@ ensures forall(i, forall(j, 0 <= i && i < j && j < roster.length ==> roster[i].name != roster[j].name)) ==> forall(i, forall(j, 0 <= i && i < j && j < \result.length ==> \result[i].name != \result[j].name))
	if (change.kind === 'other') return [...roster];
	const rest = without(roster, change.name);
	if (change.kind === 'unseated') return rest;
	const seat = { name: change.name, identity: change.identity, attention: change.attention };
	const out = [...rest, seat];
	//@ assert forall(m, 0 <= m && m < rest.length ==> out[m] == rest[m])
	//@ assert out[rest.length] == seat
	return out;
}

/** One message's place on the record and what it does to the roster. */
export interface RosterChange {
	readonly seq: number;
	readonly membership: Membership;
}

//@ contract A change sits after the composition when its position is past it.
function afterComposition(seq: number, compositionSeq: number): boolean {
	//@ ensures \result <==> seq > compositionSeq
	return seq > compositionSeq;
}

//@ contract The roster is the composition's agents, then every membership change after the composition applied in order; a change at or before the composition changes nothing, and a change that is not a membership change changes nothing.
export function foldRoster(
	agents: readonly Seating[],
	changes: readonly RosterChange[],
	compositionSeq: number,
): Seating[] {
	//@ ensures forall(i, 0 <= i && i < changes.length ==> !afterComposition(changes[i].seq, compositionSeq) || changes[i].membership.kind == 'other') ==> \result == agents
	//@ ensures forall(i, forall(j, 0 <= i && i < j && j < agents.length ==> agents[i].name != agents[j].name)) ==> forall(i, forall(j, 0 <= i && i < j && j < \result.length ==> \result[i].name != \result[j].name))
	let roster: Seating[] = [...agents];
	for (let i = 0; i < changes.length; i++) {
		//@ invariant 0 <= i && i <= changes.length
		//@ invariant forall(k, 0 <= k && k < i ==> !afterComposition(changes[k].seq, compositionSeq) || changes[k].membership.kind == 'other') ==> roster == agents
		//@ invariant forall(a, forall(b, 0 <= a && a < b && b < agents.length ==> agents[a].name != agents[b].name)) ==> forall(m, forall(n, 0 <= m && m < n && n < roster.length ==> roster[m].name != roster[n].name))
		const change = changes[i] ?? { seq: 0, membership: { kind: 'other' } };
		if (afterComposition(change.seq, compositionSeq)) roster = reseated(roster, change.membership);
	}
	return roster;
}

/** Why a directed message reaches its name, or does not. */
export type Address = 'ok' | 'unknown' | 'self' | 'unreachable';

//@ contract A directed message reaches a known name other than the author. A seat that wakes for nothing said is unreachable. An undirected message is always addressable.
export function addressOutcome(
	directed: boolean,
	known: boolean,
	self: boolean,
	seatAttention: Attention | undefined,
): Address {
	//@ requires seatAttention != undefined ==> known
	//@ ensures !directed ==> \result == 'ok'
	//@ ensures directed && !known ==> \result == 'unknown'
	//@ ensures directed && known && self ==> \result == 'self'
	//@ ensures directed && known && !self && seatAttention != undefined && seatAttention == 'none' ==> \result == 'unreachable'
	//@ ensures directed && known && !self && seatAttention == undefined ==> \result == 'ok'
	//@ ensures directed && known && !self && seatAttention != undefined && seatAttention != 'none' ==> \result == 'ok'
	//@ ensures \result == 'ok' && directed ==> known && !self
	//@ ensures \result == 'ok' && directed && seatAttention != undefined ==> seatAttention != 'none'
	if (!directed) return 'ok';
	if (!known) return 'unknown';
	if (self) return 'self';
	if (seatAttention !== undefined && seatAttention === 'none') return 'unreachable';
	return 'ok';
}
