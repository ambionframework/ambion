import { type TSchema, Type } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { decodeActivationId } from '../activation-id.ts';
import { refsRefusal } from '../refs.ts';
import type { Kind } from './journal.ts';

const extra = { additionalProperties: true } as const;
const seq = Type.Integer({ minimum: 0 });
const attention = Type.Union([
	Type.Literal('none'),
	Type.Literal('named'),
	Type.Literal('broadcast'),
	Type.Literal('presence'),
]);
const wakes = Type.Optional(Type.Array(Type.String()));
const refs = Type.Optional(Type.Array(Type.String()));
const activationId = Type.Optional(Type.String());
const commonMessage = { activationId, wakes, at: Type.String() };
const seating = Type.Object(
	{ name: Type.String(), identity: Type.String(), attention, fixed: Type.Optional(Type.Boolean()) },
	extra,
);
const covers = Type.Object({ from: seq, through: seq }, extra);

const messageSchemas: Record<string, TSchema> = {
	said: Type.Object(
		{
			...commonMessage,
			kind: Type.Literal('said'),
			from: Type.String(),
			to: Type.Optional(Type.String()),
			text: Type.String(),
			refs,
			after: Type.Optional(Type.Integer({ minimum: 1 })),
		},
		extra,
	),
	dismissed: Type.Object(
		{
			...commonMessage,
			kind: Type.Literal('dismissed'),
			from: Type.Optional(Type.String()),
			message: Type.Integer({ minimum: 1 }),
		},
		{ additionalProperties: false },
	),
	posted: Type.Object(
		{
			...commonMessage,
			kind: Type.Literal('posted'),
			to: Type.Optional(Type.String()),
			text: Type.String(),
			refs,
			returns: Type.Optional(Type.Integer({ minimum: 1 })),
		},
		extra,
	),
	arrived: presenceSchema('arrived'),
	left: presenceSchema('left'),
	seated: presenceSchema('seated'),
	unseated: presenceSchema('unseated'),
	summary: Type.Object(
		{
			...commonMessage,
			kind: Type.Literal('summary'),
			from: Type.String(),
			to: Type.String(),
			text: Type.String(),
			covers,
			refs,
		},
		extra,
	),
};
const message = Type.Union(Object.values(messageSchemas));

function presenceSchema(kind: string): TSchema {
	return Type.Object(
		{
			...commonMessage,
			kind: Type.Literal(kind),
			from: Type.Optional(Type.String()),
			subject: Type.String(),
			identity: Type.Optional(Type.String()),
			attention: Type.Optional(attention),
			fixed: Type.Optional(Type.Boolean()),
			preferences: Type.Optional(Type.String()),
		},
		extra,
	);
}

const leaseRunning = Type.Object(
	{
		id: Type.String(),
		phase: Type.Literal('running'),
		expiresAt: Type.Number(),
		at: Type.String(),
		readThrough: seq,
	},
	extra,
);
const usage = Type.Object(
	{
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		cost: Type.Optional(Type.Number()),
	},
	extra,
);
const harnessSession = Type.Object({ harness: Type.String(), id: Type.String() }, extra);
const leaseEnded = Type.Object(
	{
		id: Type.String(),
		phase: Type.Literal('ended'),
		reason: Type.Union([
			Type.Literal('released'),
			Type.Literal('failed'),
			Type.Literal('revoked'),
			Type.Literal('expired'),
			Type.Literal('abandoned'),
		]),
		at: Type.String(),
		readThrough: seq,
		usage: Type.Optional(usage),
		session: Type.Optional(harnessSession),
	},
	extra,
);
const lease = Type.Union([leaseRunning, leaseEnded]);

const schemas: Record<Kind, TSchema> = {
	message,
	lease,
	close: Type.Object(
		{
			// `person` names the first person who spoke.
			person: Type.Optional(Type.String()),
			from: seq,
			through: seq,
			at: Type.String(),
			summary: Type.Optional(Type.String()),
		},
		extra,
	),
	composition: Type.Object(
		{
			goal: Type.Optional(Type.String()),
			summary: Type.Optional(Type.String()),
			agents: Type.Array(seating),
			available: Type.Array(seating),
			at: Type.String(),
		},
		extra,
	),
	run: Type.Object({ at: Type.String() }, extra),
	cancel: Type.Object({ at: Type.String() }, extra),
};

/** Validate a room journal body. Unknown entry kinds stay outside this vocabulary. */
export function validateRoomBody(kind: string, body: unknown): kind is Kind {
	if (!Object.hasOwn(schemas, kind)) return false;
	const schema = schemaFor(kind, body);
	if (!Check(schema, body)) {
		const error = Errors(schema, body)[0];
		const path = error === undefined ? 'body' : instancePath(error);
		const reason = reasonOf(error);
		throw new Error(`Invalid room journal body for kind '${kind}' at ${path}: ${reason}.`);
	}
	const at = objectBody(body)?.at;
	if (typeof at === 'string' && !Number.isFinite(Date.parse(at)))
		throw new Error(
			`Invalid room journal body for kind '${kind}' at body.at: expected a timestamp.`,
		);
	validateActivationId(kind, objectBody(body));
	validateRanges(kind, objectBody(body));
	validateRefs(kind, objectBody(body));
	validateSchedule(kind, objectBody(body));
	validateDismissal(kind, objectBody(body));
	validateSummaryPerson(kind, objectBody(body));
	return true;
}

/**
 * A scheduled say goes to its author. The system writes a post, so it has no
 * author, and a returned say goes to the seat of the say.
 */
function validateSchedule(kind: string, body: Record<string, unknown> | undefined): void {
	if (kind !== 'message' || body === undefined) return;
	const fail = (path: string, reason: string) => {
		throw new Error(`Invalid room journal body for kind '${kind}' at ${path}: ${reason}.`);
	};
	if (body.kind === 'posted' && body.from !== undefined) fail('body.from', 'expected no author');
	if (body.kind === 'posted' && body.returns !== undefined && body.to === undefined)
		fail('body.to', 'expected the seat of the returned say');
	if (body.kind === 'said' && body.after !== undefined && body.to !== body.from)
		fail('body.to', 'expected the author');
}

/** A close that owes a summary names the person it goes to. */
function validateSummaryPerson(kind: string, body: Record<string, unknown> | undefined): void {
	if (kind !== 'close' || body?.summary === undefined || body.person !== undefined) return;
	throw new Error(
		`Invalid room journal body for kind '${kind}' at body.person: expected a person with summary.`,
	);
}

/** A seat's dismissal names its author and its activation. The host's names neither. */
function validateDismissal(kind: string, body: Record<string, unknown> | undefined): void {
	if (kind !== 'message' || body?.kind !== 'dismissed') return;
	const seat = body.from !== undefined;
	if (seat === (body.activationId !== undefined)) return;
	const path = seat ? 'body.activationId' : 'body.from';
	throw new Error(
		`Invalid room journal body for kind '${kind}' at ${path}: expected from and activationId together.`,
	);
}

/** The refs of a message with text follow the grammar the commit path applies. */
function validateRefs(kind: string, body: Record<string, unknown> | undefined): void {
	if (kind !== 'message' || body === undefined) return;
	if (body.kind !== 'said' && body.kind !== 'summary' && body.kind !== 'posted') return;
	if (body.refs === undefined) return;
	const reason = refsRefusal(body.refs);
	if (reason === undefined) return;
	throw new Error(`Invalid room journal body for kind '${kind}' at body.refs: ${reason}.`);
}

/** Every range a body carries: a close, and what a summary covers. */
function validateRanges(kind: string, body: Record<string, unknown> | undefined): void {
	if (body === undefined) return;
	if (kind === 'close') validateRange(kind, body, 'body');
	const covers =
		kind === 'message' && body.kind === 'summary' ? objectBody(body.covers) : undefined;
	if (covers !== undefined) validateRange(kind, covers, 'body.covers');
}

function validateRange(kind: string, range: Record<string, unknown>, path: string): void {
	const { from, through } = range;
	if (typeof from !== 'number' || typeof through !== 'number') return;
	// The schema above already made both integers.
	if (from >= 1 && from <= through) return;
	throw new Error(
		`Invalid room journal body for kind '${kind}' at ${path}: expected a range from 1 that ends where it starts or later.`,
	);
}

function validateActivationId(kind: string, body: Record<string, unknown> | undefined): void {
	const path = kind === 'lease' ? 'body.id' : kind === 'message' ? 'body.activationId' : undefined;
	if (path === undefined || body === undefined) return;
	const id = body[path.slice('body.'.length)];
	if (id === undefined || decodeActivationId(id) !== undefined) return;
	throw new Error(
		`Invalid room journal body for kind '${kind}' at ${path}: expected an activation id.`,
	);
}

function schemaFor(kind: string, body: unknown): TSchema {
	const topLevel = schemas[kind as Kind];
	const object = objectBody(body);
	return messageSchemaFor(kind, object) ?? leaseSchemaFor(kind, object) ?? topLevel;
}

function messageSchemaFor(
	kind: string,
	body: Record<string, unknown> | undefined,
): TSchema | undefined {
	if (kind !== 'message' || typeof body?.kind !== 'string') return undefined;
	if (!Object.hasOwn(messageSchemas, body.kind)) return undefined;
	return messageSchemas[body.kind];
}

function leaseSchemaFor(
	kind: string,
	body: Record<string, unknown> | undefined,
): TSchema | undefined {
	if (kind !== 'lease') return undefined;
	if (body?.phase === 'running') return leaseRunning;
	if (body?.phase === 'ended') return leaseEnded;
	return undefined;
}

function objectBody(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function reasonOf(error: { message: string } | undefined): string {
	return error?.message ?? 'does not match the stored shape';
}

function instancePath(error: { instancePath: string; keyword: string; params: object }): string {
	const path = error.instancePath === '' ? 'body' : pointerPath(error.instancePath);
	if (error.keyword !== 'required') return path;
	const requiredProperties = (error.params as { requiredProperties?: unknown }).requiredProperties;
	const field = Array.isArray(requiredProperties) ? requiredProperties[0] : undefined;
	return typeof field === 'string' ? `${path}.${field}` : path;
}

function pointerPath(pointer: string): string {
	return pointer
		.split('/')
		.slice(1)
		.reduce((path, part) => (/^\d+$/.test(part) ? `${path}[${part}]` : `${path}.${part}`), 'body');
}
