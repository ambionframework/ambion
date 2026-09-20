/**
 * What crosses between a seat and its room. Every shape here is plain JSON:
 * an optional key is written only when it is present, and no value is
 * `undefined`, a `Date`, a `Map`, a `Set`, a class instance or a function. A
 * request and its response survive a round trip through `JSON.stringify`
 * unchanged, which is what lets a seat and a room live in two processes.
 *
 * The seat reaches the room through three calls: `view` reads what an
 * activation is given, `commit` puts one message on the record, and
 * `lease` claims, renews or releases the activation. The room reaches a
 * seat through three calls: `wake` starts an activation, `steer` sends
 * context to one running activation, and `cut` stops an activation whose
 * lease the room ended.
 */
import type {
	AgentParticipantInfo,
	EndReason,
	FailureCause,
	HumanParticipantInfo,
	Intent,
	Message,
	Seq,
	Without,
} from './types.ts';

/** The work authorized by the room, with the facts that purpose requires. */
export type ActivationPurpose =
	| { readonly kind: 'respond'; readonly message: Seq }
	| {
			readonly kind: 'summarize';
			readonly exchange: Seq;
			readonly person: string;
			readonly through: Seq;
	  };

/** The authority one recorded activation grants to its seat. */
export interface ActivationSpec {
	readonly id: string;
	readonly seat: string;
	readonly attempt: number;
	readonly purpose: ActivationPurpose;
}

// -- the room reaching a seat -------------------------------------------------

/** A wake names an activation the seat runs. */
export interface Wake {
	room: string;
	seat: string;
	activation: string;
}

/** A message the room sends to one activation that is already running. */
export interface Steer {
	room: string;
	seat: string;
	/** The exact activation that was at work when the message landed. */
	activation: string;
	after: Seq;
	message: Message;
}

export interface AgentPort {
	wake(wake: Wake): Promise<void>;
	steer(steer: Steer): Promise<void>;
	/** The room ended this activation's lease: stop it, and run what queued behind it. */
	cut(activation: string): Promise<void>;
}

// -- a seat reaching its room -------------------------------------------------

/** Public participant facts with each person's recorded reading progress. */
export type ContextParticipant =
	| AgentParticipantInfo
	| (HumanParticipantInfo & {
			readonly changedAt?: string;
			readonly lastDeparture?: Seq;
			readonly messagesSinceDeparture: number;
	  });

/** Collaboration facts selected for one activation. Private executable definitions stay with the executor. */
export interface CollaborationContext {
	readonly name: string;
	readonly now: number;
	readonly goal?: string;
	readonly participants: readonly ContextParticipant[];
	readonly messages: readonly Without<Message, 'preferences'>[];
	/** The open exchange for an ordinary response. */
	readonly exchange?: { readonly owner: string; readonly from: Seq };
	/** Reserve identities are available to every responding agent. */
	readonly reserve: readonly { readonly name: string; readonly identity: string }[];
	/** Only the summary writer reads the owner's preferences. */
	readonly preferences?: string;
	/**
	 * The lowest message position the record holds. The room reports it only for
	 * a bounded page, so a seat that windows the record knows where the record
	 * ends and stops paging.
	 */
	readonly earliest?: Seq;
	/**
	 * How many messages of the record this activation may read lie below the
	 * first one in `messages`. The room reports it beside `earliest`. A seat
	 * that windows further adds what it dropped.
	 */
	readonly omitted?: number;
}

/**
 * A bounded read of the record for one view. The room returns the messages
 * before `before` (the tail when it is absent), keeping the last `limit` of
 * them. The room aligns a page floor to the summaries the page holds, so one
 * page never renders a fold with a wrong count. A seat that wants an older
 * range reads the next page from the lowest position it holds.
 */
export interface ViewRange {
	readonly before?: Seq;
	readonly limit: number;
}

export interface ActivationView {
	/** The identity and purpose authorized by the room. */
	spec: ActivationSpec;
	/** The context boundary represented by this view. Consumption acknowledges it. */
	through: Seq;
	context: CollaborationContext;
}

/** The request the lease answers is gone: the lease ended, or the room did. */
export interface Stale {
	stale: string;
}

export type ViewResponse = { view: ActivationView } | Stale;

export type { Intent };

export interface CommitRequest {
	activation: string;
	key: string;
	readThrough?: Seq;
	intent: Intent;
}

/**
 * What a seat's commit call resolves to. The room stamps every case but
 * `unknown`. A transport that loses the confirmation of a commit resolves the
 * call to `unknown`: the message may or may not have landed. The commit key
 * makes a retry safe, so the seat retries first and reports `unknown` only
 * when no attempt confirms.
 */
export type CommitResult =
	| { committed: Message }
	| { unchanged: { kind: 'seated' | 'unseated'; name: string } }
	| { missed: Message[] }
	| { refused: string }
	| { unknown: string }
	| Stale;

export type LeaseRequest =
	| { activation: string; operation: 'claim' }
	| { activation: string; operation: 'renew'; readThrough?: Seq }
	| {
			activation: string;
			operation: 'release';
			reason: EndReason;
			readThrough: Seq;
			cause?: FailureCause;
	  };

/**
 * The lease holds, with its expiry and the last place on the record. The seat
 * reads `lastSeq` against what its view held: the record moved when it grew.
 * An entry beside the record moves neither, so a renewal never reports its
 * own landing as movement.
 */
export type LeaseResponse = { ok: { expiresAt: number; lastSeq: Seq } } | Stale;

export interface RoomProtocol {
	view(activation: string, range?: ViewRange): Promise<ViewResponse>;
	commit(commit: CommitRequest): Promise<CommitResult>;
	lease(lease: LeaseRequest): Promise<LeaseResponse>;
}

// -- checks --------------------------------------------------------------------

/** The value as it comes back from the wire. */
export function roundTrip<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

const PLAIN = new Set(['Object', 'Array']);

/** Throws when a value would not survive the wire as it is. */
export function assertWire(value: unknown, path = '$'): void {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number.`);
		return;
	}
	if (typeof value !== 'object') throw new Error(`${path} is a ${typeof value}.`);
	const tag = (value as object).constructor?.name ?? 'Object';
	if (!PLAIN.has(tag)) throw new Error(`${path} is a ${tag}.`);
	for (const [key, item] of Object.entries(value as Record<string, unknown>))
		assertKey(item, `${path}.${key}`);
}

function assertKey(item: unknown, path: string): void {
	if (item === undefined) throw new Error(`${path} is undefined.`);
	assertWire(item, path);
}
