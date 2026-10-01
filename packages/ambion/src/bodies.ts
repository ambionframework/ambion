/**
 * The stored bodies: what each journal entry of the room holds, as schemas.
 *
 * A schema here is the one source of its body. The type of the body derives
 * from it with `Static`, and the journal validates each entry against it.
 * `types.ts` and `journal/events.ts` name the derived types. A rule that
 * spans fields stays in code, in `journal/validate.ts`.
 */

import { Type } from 'typebox';

/** A body accepts a field that its schema does not name. */
const extra = { additionalProperties: true } as const;

/** A position on the record. */
const seq = Type.Integer({ minimum: 0 });

/** Why a lease ended. */
export const endReasonSchema = Type.Union([
	Type.Literal('released'),
	Type.Literal('failed'),
	Type.Literal('revoked'),
	Type.Literal('expired'),
	Type.Literal('abandoned'),
]);

export const failureCauseSchema = Type.Union([
	Type.Literal('permanent'),
	Type.Literal('transient'),
]);

export const attentionSchema = Type.Union([
	Type.Literal('none'),
	Type.Literal('named'),
	Type.Literal('broadcast'),
	Type.Literal('presence'),
]);

export const usageSchema = Type.Object(
	{
		input: Type.Readonly(Type.Number()),
		output: Type.Readonly(Type.Number()),
		cacheRead: Type.Readonly(Type.Number()),
		cacheWrite: Type.Readonly(Type.Number()),
		cost: Type.Optional(Type.Readonly(Type.Number())),
	},
	extra,
);

export const harnessSessionSchema = Type.Object(
	{ harness: Type.Readonly(Type.String()), id: Type.Readonly(Type.String()) },
	extra,
);

// -- messages -----------------------------------------------------------------

/** The fields that every message body holds. */
const common = {
	/** The activation that wrote it. Absent when a person or the host wrote it. */
	activationId: Type.Optional(Type.String()),
	/** The seats the room decided to wake for it, written with the message. */
	wakes: Type.Optional(Type.Array(Type.String())),
	/** ISO timestamp, stamped by the runtime at the moment it landed. */
	at: Type.String(),
};

/** The citation that a message with text holds. */
const cited = {
	/**
	 * URIs the message cites. The room validates and stores them and never reads
	 * behind one. Absent when the author cited nothing.
	 */
	refs: Type.Optional(Type.Array(Type.String())),
};

export const saidSchema = Type.Object(
	{
		...common,
		kind: Type.Literal('said'),
		/** The name of the participant. The runtime stamps it. */
		from: Type.String(),
		/** Present when the delivery or say was directed. */
		to: Type.Optional(Type.String()),
		text: Type.String(),
		...cited,
		/**
		 * Seconds after `at` when the room returns the say to its author. Present
		 * only on a say that an agent addressed to itself: a scheduled say.
		 */
		after: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	extra,
);

export const dismissedSchema = Type.Object(
	{
		...common,
		kind: Type.Literal('dismissed'),
		from: Type.Optional(Type.String()),
		/** The seq of the scheduled say. */
		message: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const postedSchema = Type.Object(
	{
		...common,
		kind: Type.Literal('posted'),
		/** The seat or the person it goes to. Absent for a post to the room. */
		to: Type.Optional(Type.String()),
		text: Type.String(),
		...cited,
		/**
		 * On a returned say, the seq of the scheduled say. The post copies the text
		 * and the refs of that say, and `to` names the seat that scheduled it.
		 */
		returns: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	extra,
);

/**
 * The four ways a participant's presence changes: a person arrives or leaves,
 * and an agent is seated or unseated while the room runs.
 */
export const presenceChangeSchema = Type.Union([
	Type.Literal('arrived'),
	Type.Literal('left'),
	Type.Literal('seated'),
	Type.Literal('unseated'),
]);

export const presenceSchema = Type.Object(
	{
		...common,
		kind: presenceChangeSchema,
		/**
		 * Who wrote it, the way every other kind reads `from`. A person writes
		 * their own arrival and their own departure. An agent writes a
		 * seating it decided. A seating the host decided has no author: the host
		 * is not a participant, and nothing on the record speaks for it.
		 */
		from: Type.Optional(Type.String()),
		/**
		 * The participant whose presence changed: a person, stamped from the visit
		 * the runtime observed, or the agent the runtime seated or unseated. On an
		 * arrival and a departure it is the author, because a person's presence is
		 * theirs to change.
		 */
		subject: Type.String(),
		/**
		 * How the room knew them, on `arrived` and `seated`. Replay rebuilds the
		 * roster from the record, and a name without an identity is not a roster line.
		 */
		identity: Type.Optional(Type.String()),
		/** What wakes the seat, on `seated`. Absent means `broadcast`. */
		attention: Type.Optional(attentionSchema),
		/**
		 * Whether an agent cannot unseat this seat, on `seated`. Absent leaves the
		 * default to the seat's own name: the summary writer's seat is fixed
		 * unless this says `false`.
		 */
		fixed: Type.Optional(Type.Boolean()),
		/** How the person reads, on `arrived`, when they said so. */
		preferences: Type.Optional(Type.String()),
	},
	extra,
);

export const summarySchema = Type.Object(
	{
		...common,
		kind: Type.Literal('summary'),
		/** The agent that wrote it. */
		from: Type.String(),
		/** The person the summary addresses: a person who spoke in the range. */
		to: Type.String(),
		text: Type.String(),
		/** The range it stands for, ending at the last message before this one. */
		covers: Type.Object({ from: seq, through: seq }, extra),
		...cited,
	},
	extra,
);

// -- leases -------------------------------------------------------------------

export const leaseRunningSchema = Type.Object(
	{
		id: Type.String(),
		phase: Type.Literal('running'),
		expiresAt: Type.Number(),
		at: Type.String(),
		readThrough: seq,
	},
	extra,
);

export const leaseEndedSchema = Type.Object(
	{
		id: Type.String(),
		phase: Type.Literal('ended'),
		reason: endReasonSchema,
		at: Type.String(),
		readThrough: seq,
		/** Why the activation failed, on a failed or abandoned end. */
		cause: Type.Optional(failureCauseSchema),
		/** What the activation spent, on an end its driver wrote. */
		usage: Type.Optional(usageSchema),
		/** The harness session the activation ended with, when the harness reports one. */
		session: Type.Optional(harnessSessionSchema),
	},
	extra,
);

export const leaseSchema = Type.Union([leaseRunningSchema, leaseEndedSchema]);

// -- the other entries --------------------------------------------------------

export const closeSchema = Type.Object(
	{
		/** The first person who spoke in the range. */
		person: Type.Optional(Type.String()),
		from: seq,
		through: seq,
		at: Type.String(),
		/** The configured seated agent that writes the summary, when the close owes one. */
		summary: Type.Optional(Type.String()),
	},
	extra,
);

export const seatingSchema = Type.Object(
	{
		name: Type.String(),
		identity: Type.String(),
		attention: attentionSchema,
		/** An agent cannot unseat this seat, when stated. See `room/fold.ts`'s `isFixed`. */
		fixed: Type.Optional(Type.Boolean()),
	},
	extra,
);

export const compositionSchema = Type.Object(
	{
		goal: Type.Optional(Type.String()),
		/** The configured agent that writes summaries for human owners. */
		summary: Type.Optional(Type.String()),
		agents: Type.Array(seatingSchema),
		available: Type.Array(seatingSchema),
		at: Type.String(),
	},
	extra,
);

export const runSchema = Type.Object({ at: Type.String() }, extra);

export const cancelSchema = Type.Object({ at: Type.String() }, extra);
