/**
 * Prototype: every activation-id rule of the group, in one file LemmaScript
 * checks. Each body is what `activation.ts`, `lease.ts`, `answers.ts`,
 * `reconcile.ts`, `exchange.ts`, `summary.ts`, `transition.ts` and
 * `activation-id.ts` run, or would run, at the call site the report names.
 *
 * The file copies the landed rules its contracts name (`nextAttempt`,
 * `beforeCancellation`, `survivesCancellation`, `permits`), so it verifies
 * on its own. The landed file wins where the two differ.
 */

// -- the vocabulary -----------------------------------------------------------

/** The journal fact that gives an activation its identity. The same union as `ActivationSource` in `activation-id.ts`. */
export type ActivationSource = 'message' | 'closed';

/** The fields an activation id encodes. The same shape as `ActivationId` in `activation-id.ts`. */
export interface ActivationFields {
	readonly source: ActivationSource;
	readonly position: number;
	readonly seat: string;
	readonly attempt: number;
}

/** One seat on the roster, as membership reads it. `Seating` in `events.ts` passes as this. */
export interface Seat {
	readonly name: string;
}

/** One durable removal of a seat: who left, and where on the record. */
export interface Unseating {
	readonly subject: string;
	readonly seq: number;
}

/** A close, as the closing grant reads it. `Close` in `events.ts` passes as this. */
export interface CloseFact {
	readonly owner: string;
	readonly from: number;
	readonly through: number;
	readonly summary?: string;
}

/** What an activation is for. The same shape as `ActivationPurpose` in `protocol.ts`. */
export type GrantPurpose =
	| { readonly kind: 'respond'; readonly message: number }
	| {
			readonly kind: 'summarize';
			readonly exchange: number;
			readonly person: string;
			readonly through: number;
	  };

/** The authority one decoded id grants: `ActivationSpec` in `protocol.ts` without the id string. */
export interface Grant {
	readonly seat: string;
	readonly attempt: number;
	readonly purpose: GrantPurpose;
}

/** What an activation is for: an answer to a message, or a closing summary. */
export type Purpose = 'respond' | 'summarize';

/** What a commit asks for. */
export type Intent = 'said' | 'seated' | 'unseated';

// -- landed rules the contracts name -------------------------------------------

//@ contract The next attempt is numbered after the failed ones.
function nextAttempt(attempts: number): number {
	//@ requires attempts >= 0
	//@ ensures \result == attempts + 1
	//@ ensures \result >= 1
	return attempts + 1;
}

//@ contract A cause before a cancellation marker belongs to cancelled work.
export function beforeCancellation(position: number, cancelledAt: number): boolean {
	//@ ensures \result <==> position < cancelledAt
	return position < cancelledAt;
}

//@ contract Work survives a cancellation when no marker stands, or its cause is at or after the marker.
export function survivesCancellation(position: number, cancelledAt: number | undefined): boolean {
	//@ ensures cancelledAt == undefined ==> \result
	//@ ensures cancelledAt != undefined ==> (\result <==> !beforeCancellation(position, cancelledAt))
	//@ ensures cancelledAt != undefined ==> (\result <==> position >= cancelledAt)
	if (cancelledAt === undefined) return true;
	return !beforeCancellation(position, cancelledAt);
}

// -- accept-fields-codec-domain -----------------------------------------------

//@ contract A position or an attempt is bounded when it is at least one and at most the largest safe integer. Integrality and the string form stay in `activation-id.ts`.
export function positiveBounded(value: number): boolean {
	//@ ensures \result <==> (1 <= value && value <= 9007199254740991)
	return value >= 1 && value <= 9007199254740991;
}

//@ contract A decoded id is well formed when its position and attempt are at least one and its seat has a name.
export function wellFormed(id: ActivationFields): boolean {
	//@ ensures \result <==> (id.position >= 1 && id.attempt >= 1 && id.seat.length >= 1)
	return id.position >= 1 && id.attempt >= 1 && id.seat.length >= 1;
}

// -- next-activation-id -------------------------------------------------------

//@ contract The id of the next attempt carries the cause, its position and the seat unchanged, and numbers the attempt one past those that came to nothing. Nothing mints an id.
export function nextActivationId(
	source: ActivationSource,
	position: number,
	seat: string,
	unsuccessfulAttempts: number,
): ActivationFields {
	//@ requires position >= 1
	//@ requires seat.length >= 1
	//@ requires unsuccessfulAttempts >= 0
	//@ ensures \result.source == source && \result.position == position && \result.seat == seat
	//@ ensures \result.attempt == nextAttempt(unsuccessfulAttempts)
	//@ ensures \result.attempt == unsuccessfulAttempts + 1
	//@ ensures wellFormed(\result)
	return { source, position, seat, attempt: nextAttempt(unsuccessfulAttempts) };
}

// -- seated-on-roster ---------------------------------------------------------

//@ contract A name is on the roster exactly when some seat carries it.
export function seated(roster: readonly Seat[], name: string): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < roster.length && roster[i].name == name)
	return roster.some((seat) => seat.name === name);
}

// -- removed-after ------------------------------------------------------------

//@ contract A seat unseated after a position makes every activation caused at or before that position stale, and a later seating of the same name revives none of them. An unseating at the position itself changes nothing.
export function unseatedAfter(
	unseatings: readonly Unseating[],
	seat: string,
	position: number,
): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < unseatings.length && unseatings[i].subject == seat && unseatings[i].seq > position)
	//@ ensures !\result ==> forall(i, 0 <= i && i < unseatings.length && unseatings[i].subject == seat ==> unseatings[i].seq <= position)
	//@ ensures \result ==> forall(earlier, earlier <= position ==> unseatedAfter(unseatings, seat, earlier))
	return unseatings.some((u) => u.subject === seat && u.seq > position);
}

// -- close-for-writer ---------------------------------------------------------

//@ contract A close names a writer when it carries that name as its summary writer. A close with no writer names nobody.
export function names(summary: string | undefined, writer: string): boolean {
	//@ ensures summary == undefined ==> !\result
	//@ ensures summary != undefined ==> (\result <==> summary == writer)
	if (summary === undefined) return false;
	return summary === writer;
}

//@ contract A close answers a closed-source id when its boundary is the id's position and it names the id's seat as writer.
export function closeMatches(close: CloseFact, through: number, writer: string): boolean {
	//@ ensures \result <==> (close.through == through && names(close.summary, writer))
	return close.through === through && names(close.summary, writer);
}

//@ contract The close that answers a closed-source id is the first close that matches it. When none matches, there is no close.
export function closeFor(
	closes: readonly CloseFact[],
	through: number,
	writer: string,
): CloseFact | undefined {
	//@ ensures \result != undefined ==> closeMatches(\result, through, writer)
	//@ ensures \result != undefined ==> exists(j, 0 <= j && j < closes.length && closes[j] == \result && forall(k, 0 <= k && k < j ==> !closeMatches(closes[k], through, writer)))
	//@ ensures \result == undefined ==> forall(j, 0 <= j && j < closes.length ==> !closeMatches(closes[j], through, writer))
	return closes.find((close) => closeMatches(close, through, writer));
}

// -- activation-grant ---------------------------------------------------------

//@ contract A decoded id grants exactly one authority, or nothing. Nothing for a cause before the cancellation marker, for a seat off the roster, or for a seat unseated after the cause. A message id grants a response only for a recorded message. A closed id grants a summary only for the close that names the seat, and the summary is over that close's exchange, for its owner, through its boundary. The grant's seat and attempt are the id's own.
export function activationGrant(
	id: ActivationFields,
	cancelledAt: number | undefined,
	roster: readonly Seat[],
	unseatings: readonly Unseating[],
	recorded: boolean,
	close: CloseFact | undefined,
): Grant | undefined {
	//@ requires wellFormed(id)
	//@ requires close != undefined ==> closeMatches(close, id.position, id.seat)
	//@ ensures \result != undefined ==> \result.seat == id.seat && \result.attempt == id.attempt
	//@ ensures \result != undefined ==> survivesCancellation(id.position, cancelledAt)
	//@ ensures \result != undefined && cancelledAt != undefined ==> !beforeCancellation(id.position, cancelledAt)
	//@ ensures \result != undefined ==> seated(roster, id.seat)
	//@ ensures \result != undefined ==> !unseatedAfter(unseatings, id.seat, id.position)
	//@ ensures \result != undefined ==> (\result.purpose.kind == 'respond' <==> id.source == 'message')
	//@ ensures \result != undefined && id.source == 'message' ==> recorded && \result.purpose.message == id.position
	//@ ensures \result != undefined && id.source == 'closed' ==> close != undefined && \result.purpose.through == id.position
	//@ ensures \result != undefined && id.source == 'closed' && close != undefined ==> \result.purpose.exchange == close.from && \result.purpose.person == close.owner && \result.purpose.through == close.through
	//@ ensures id.source == 'message' && recorded && survivesCancellation(id.position, cancelledAt) && seated(roster, id.seat) && !unseatedAfter(unseatings, id.seat, id.position) ==> \result != undefined
	//@ ensures id.source == 'closed' && close != undefined && survivesCancellation(id.position, cancelledAt) && seated(roster, id.seat) && !unseatedAfter(unseatings, id.seat, id.position) ==> \result != undefined
	if (!survivesCancellation(id.position, cancelledAt)) return undefined;
	if (!seated(roster, id.seat)) return undefined;
	if (unseatedAfter(unseatings, id.seat, id.position)) return undefined;
	if (id.source === 'message') {
		if (!recorded) return undefined;
		return {
			seat: id.seat,
			attempt: id.attempt,
			purpose: { kind: 'respond', message: id.position },
		};
	}
	if (close === undefined) return undefined;
	return {
		seat: id.seat,
		attempt: id.attempt,
		purpose: {
			kind: 'summarize',
			exchange: close.from,
			person: close.owner,
			through: close.through,
		},
	};
}

// -- permits-purpose-intent ---------------------------------------------------

//@ contract Both purposes permit speech. Only a response permits a seating or an unseating. A closing activation can do nothing but speak.
export function permits(purpose: Purpose, intent: Intent): boolean {
	//@ ensures intent == 'said' ==> \result
	//@ ensures intent != 'said' ==> (\result <==> purpose == 'respond')
	//@ ensures purpose == 'summarize' ==> (\result <==> intent == 'said')
	//@ ensures purpose == 'respond' ==> \result
	switch (intent) {
		case 'said':
			return purpose === 'respond' || purpose === 'summarize';
		case 'seated':
		case 'unseated':
			return purpose === 'respond';
	}
}
