import { type TSchema, Type } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { decodeActivationId } from '../activation-id.ts';
import { refsRefusal } from '../refs.ts';
import { JOURNAL_FORMAT } from './events.ts';
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
const cancelClose = Type.Object(
	{
		owner: Type.String(),
		from: seq,
		through: seq,
		at: Type.String(),
	},
	{ additionalProperties: false },
);

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
			owner: Type.Optional(Type.String()),
		},
		extra,
	),
	returned: Type.Object(
		{
			...commonMessage,
			kind: Type.Literal('returned'),
			to: Type.String(),
			message: Type.Integer({ minimum: 1 }),
			owner: Type.String(),
			text: Type.String(),
			refs,
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
			owner: Type.String(),
			from: seq,
			through: seq,
			at: Type.String(),
			summary: Type.Optional(Type.String()),
		},
		extra,
	),
	composition: Type.Object(
		{
			version: Type.Literal(2),
			goal: Type.Optional(Type.String()),
			summary: Type.Optional(Type.String()),
			agents: Type.Array(seating),
			available: Type.Array(seating),
			at: Type.String(),
		},
		extra,
	),
	// The format stays permissive here. A schema literal would drop a newer
	// fence without a word; validateRunFormat refuses it loudly.
	run: Type.Object({ at: Type.String(), format: Type.Optional(Type.Integer()) }, extra),
	cancel: Type.Object({ at: Type.String(), close: Type.Optional(cancelClose) }, extra),
};

/** Validate a room journal body. Unknown entry kinds stay outside this vocabulary. */
export function validateRoomBody(kind: string, body: unknown): kind is Kind {
	if (!Object.hasOwn(schemas, kind)) return false;
	if (kind === 'composition') validateCompositionVersion(body);
	if (kind === 'run') validateRunFormat(body);
	const schema = schemaFor(kind, body);
	if (!Check(schema, body)) {
		const error = Errors(schema, body)[0];
		const path = error === undefined ? 'body' : instancePath(error);
		const reason = error?.message ?? 'does not match the stored shape';
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
	return true;
}

/** The refs of a message with text follow the grammar the commit path applies. */
function validateRefs(kind: string, body: Record<string, unknown> | undefined): void {
	if (kind !== 'message' || body === undefined) return;
	if (body.kind !== 'said' && body.kind !== 'summary' && body.kind !== 'returned') return;
	if (body.refs === undefined) return;
	const reason = refsRefusal(body.refs);
	if (reason === undefined) return;
	throw new Error(`Invalid room journal body for kind '${kind}' at body.refs: ${reason}.`);
}

/** Every range a body carries: a close, the close a cancel carries, and what a summary covers. */
function validateRanges(kind: string, body: Record<string, unknown> | undefined): void {
	if (body === undefined) return;
	if (kind === 'close') validateRange(kind, body, 'body');
	if (kind === 'cancel') validateRange(kind, objectBody(body.close), 'body.close');
	if (kind === 'message' && body.kind === 'summary')
		validateRange(kind, objectBody(body.covers), 'body.covers');
}

function validateRange(
	kind: string,
	range: Record<string, unknown> | undefined,
	path: string,
): void {
	if (range === undefined) return;
	const { from, through } = range;
	if (typeof from !== 'number' || typeof through !== 'number') return;
	// The schema above already made both integers.
	if (from >= 1 && from <= through) return;
	throw new Error(
		`Invalid room journal body for kind '${kind}' at ${path}: expected a range from 1 that ends where it starts or later.`,
	);
}

function validateCompositionVersion(body: unknown): void {
	const object = objectBody(body);
	const version = object?.version;
	if (object !== undefined && Object.hasOwn(object, 'assistant')) {
		throw new Error(
			'Unsupported room composition version (legacy assistant field); expected version 2. Start a new journal or migrate this journal externally.',
		);
	}
	if (version === 2) return;
	const found = version === undefined ? 'missing' : JSON.stringify(version);
	throw new Error(
		`Unsupported room composition version (${found}); expected version 2. Start a new journal or migrate this journal externally.`,
	);
}

/**
 * A run entry without a format is format 1. Any other format is a journal a
 * newer runtime wrote. Before 1.0.0 a new format adds no reader for an older
 * one.
 */
function validateRunFormat(body: unknown): void {
	const format = objectBody(body)?.format;
	if (format === undefined || format === JOURNAL_FORMAT) return;
	throw new Error(
		`Unsupported journal format (${JSON.stringify(format)}); this runtime reads format ${JOURNAL_FORMAT}. Upgrade the runtime or migrate this journal externally.`,
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
