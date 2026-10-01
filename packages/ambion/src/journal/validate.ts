import { type TSchema, Type } from 'typebox';
import { Check, Errors } from 'typebox/value';
import { decodeActivationId } from '../activation-id.ts';
import {
	cancelSchema,
	closeSchema,
	compositionSchema,
	dismissedSchema,
	leaseEndedSchema,
	leaseRunningSchema,
	leaseSchema,
	postedSchema,
	presenceSchema,
	runSchema,
	saidSchema,
	summarySchema,
} from '../bodies.ts';
import { refsRefusal } from '../refs.ts';
import type { Kind } from './journal.ts';

const messageSchemas: Record<string, TSchema> = {
	said: saidSchema,
	dismissed: dismissedSchema,
	posted: postedSchema,
	arrived: presenceSchema,
	left: presenceSchema,
	seated: presenceSchema,
	unseated: presenceSchema,
	summary: summarySchema,
};
const message = Type.Union([
	saidSchema,
	dismissedSchema,
	postedSchema,
	presenceSchema,
	summarySchema,
]);

const schemas: Record<Kind, TSchema> = {
	message,
	lease: leaseSchema,
	close: closeSchema,
	composition: compositionSchema,
	run: runSchema,
	cancel: cancelSchema,
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
	if (body?.phase === 'running') return leaseRunningSchema;
	if (body?.phase === 'ended') return leaseEndedSchema;
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
