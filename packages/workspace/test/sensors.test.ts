import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { expect, it } from 'vitest';
import { validRefName } from '../src/git-names.ts';
import {
	isValidObserveRequest,
	ObserveRequestSchema,
	ObserveResponseSchema,
	SensorApiSchema,
	SensorErrorSchema,
	SensorIndexSchema,
	SensorPartSchema,
} from '../src/sensors.ts';

const from = '2026-09-29T10:00:00.000Z';
const to = '2026-09-29T10:00:01.000Z';
const digest = 'a'.repeat(64);

const index = {
	api: 1,
	source: {
		repository: 'instruments/bench-sensors',
		commit: 'b'.repeat(40),
		branch: 'main',
		dirty: false,
	},
	sensors: [{ name: 'dmm', description: 'Digital multimeter', spans: true }],
};

const request = { api: 1, span: { from, to } };

const parts = [
	{ kind: 'text', text: 'Stable at 5 V.' },
	{ kind: 'frame', file: digest, mediaType: 'image/png' },
	{
		kind: 'series',
		channel: 'voltage',
		unit: 'V',
		from,
		intervalMs: 0.25,
		values: [4.99, 5, 5.01],
	},
	{ kind: 'file', file: digest, name: 'reading.csv', mediaType: 'text/csv' },
] as const;

const response = {
	api: 1,
	observations: [
		{ at: from, parts: [parts[0]] },
		{ at: '2026-09-29T10:00:00.250Z', parts: [parts[1], parts[2], parts[3]] },
	],
};

const error = { api: 1, code: 'invalid', message: 'The request is invalid.' };

const accepts = (schema: TSchema, value: unknown) => Value.Check(schema, value);

async function publishedDefinitions(): Promise<Record<string, TSchema>> {
	const file = fileURLToPath(new URL('../dist/sensor-api.schema.json', import.meta.url));
	const published = JSON.parse(await readFile(file, 'utf8')) as { $defs: Record<string, TSchema> };
	return published.$defs;
}

function requiredDefinition(defs: Record<string, TSchema>, name: string): TSchema {
	const schema = defs[name];
	if (schema === undefined) throw new Error(`The published schema has no ${name} definition.`);
	return schema;
}

it('validates the documented discovery, latest and span requests, response, and error samples', () => {
	expect(accepts(SensorIndexSchema, index)).toBe(true);
	expect(accepts(ObserveRequestSchema, { api: 1 })).toBe(true);
	expect(isValidObserveRequest({ api: 1 })).toBe(true);
	expect(accepts(ObserveRequestSchema, request)).toBe(true);
	expect(isValidObserveRequest(request)).toBe(true);
	expect(accepts(ObserveResponseSchema, response)).toBe(true);
	expect(accepts(ObserveResponseSchema, { api: 1, observations: [] })).toBe(true);
	expect(accepts(SensorErrorSchema, error)).toBe(true);
	for (const part of parts) {
		expect(accepts(SensorPartSchema, part)).toBe(true);
	}
});

it.each([
	['uppercase name', 'Dmm'],
	['leading digit', '2dmm'],
	['slash', 'bench/dmm'],
	['trailing newline', 'dmm\n'],
])('rejects a sensor name with %s', (_case, name) => {
	const bad = { ...index, sensors: [{ ...index.sensors[0], name }] };
	expect(accepts(SensorIndexSchema, bad)).toBe(false);
});

it.each([
	['repository with a trailing newline', { repository: 'instruments/bench-sensors\n' }],
	['repository without a namespace', { repository: 'bench-sensors' }],
	['short commit', { commit: 'b'.repeat(39) }],
	['commit with a trailing newline', { commit: `${'b'.repeat(40)}\n` }],
	['branch with a trailing newline', { branch: 'main\n' }],
	['branch with a leading slash', { branch: '/main' }],
	['branch with a trailing slash', { branch: 'main/' }],
	['branch with a leading dot', { branch: '.main' }],
	['nonboolean dirty flag', { dirty: 'false' }],
	['unknown metadata', { worktree: 'main' }],
])('rejects source metadata with %s', (_case, change) => {
	const bad = { ...index, source: { ...index.source, ...change } };
	expect(accepts(SensorIndexSchema, bad)).toBe(false);
});

it('accepts detached and dirty source metadata without requiring a branch', () => {
	const { repository, commit } = index.source;
	const detached = {
		...index,
		source: { repository, commit, dirty: true },
	};
	expect(accepts(SensorIndexSchema, detached)).toBe(true);
});

it('accepts SHA-1 and SHA-256 commit identifiers', () => {
	for (const source of [
		{ ...index.source, commit: 'b'.repeat(40) },
		{ ...index.source, commit: 'b'.repeat(64) },
	]) {
		expect(accepts(SensorIndexSchema, { ...index, source })).toBe(true);
	}
});

it.each([
	['main', true],
	['@x', true],
	[']', true],
	['feature/pour', true],
	['a\u2028/b', true],
	['a\u2029/b', true],
	['a.lock\u2028', true],
	['a.lock\u2029', true],
	['@', false],
	['main/', false],
	['/main', false],
	['.main', false],
	['main/.hidden', false],
	['a.lock', false],
	['a\n', false],
	['a\u2028/b..c', false],
	['a\u2029/b..c', false],
	['a\u2028/.hidden', false],
	['a\u2029/.hidden', false],
])('matches the Git ref-name rules for branch %j', (branch, valid) => {
	const source = { ...index.source, branch };
	expect(validRefName(branch)).toBe(valid);
	expect(accepts(SensorIndexSchema, { ...index, source })).toBe(valid);
});

it.each([
	['uppercase digest', `${'A'.repeat(64)}`],
	['short digest', 'a'.repeat(63)],
	['digest with a trailing newline', `${'a'.repeat(64)}\n`],
])('rejects a file part with a %s', (_case, file) => {
	const bad = { kind: 'frame', file, mediaType: 'image/png' };
	expect(accepts(SensorPartSchema, bad)).toBe(false);
});

it.each([
	['February 30', '2026-02-30T10:00:00.000Z'],
	['February 29 in a non-leap year', '2025-02-29T10:00:00.000Z'],
	['missing milliseconds', '2026-09-29T10:00:00Z'],
	['non-UTC offset', '2026-09-29T10:00:00.000+00:00'],
	['timestamp with a trailing newline', `${from}\n`],
])('rejects %s as a canonical measurement time', (_case, at) => {
	expect(accepts(ObserveResponseSchema, { api: 1, observations: [{ at, parts: [] }] })).toBe(false);
});

it.each([
	['1900, not a leap year', '1900-02-29T10:00:00.000Z', false],
	['2000, a leap year', '2000-02-29T10:00:00.000Z', true],
	['2100, not a leap year', '2100-02-29T10:00:00.000Z', false],
])('checks Gregorian leap years: %s', (_case, at, valid) => {
	expect(accepts(ObserveResponseSchema, { api: 1, observations: [{ at, parts: [] }] })).toBe(valid);
});

it.each([
	['zero', 0],
	['negative', -1],
	['NaN', Number.NaN],
	['positive infinity', Number.POSITIVE_INFINITY],
	['negative infinity', Number.NEGATIVE_INFINITY],
])('rejects a series interval that is %s', (_case, intervalMs) => {
	const bad = { ...parts[2], intervalMs };
	expect(accepts(SensorPartSchema, bad)).toBe(false);
});

it.each([
	['missing text', { kind: 'text' }],
	['extra text property', { kind: 'text', text: 'ok', file: digest }],
	['unsupported frame media type', { kind: 'frame', file: digest, mediaType: 'image/gif' }],
	['missing series values', { kind: 'series', channel: 'v', unit: 'V', from, intervalMs: 1 }],
	['nonfinite series value', { ...parts[2], values: [Number.NaN] }],
	['missing file name', { kind: 'file', file: digest, mediaType: 'text/csv' }],
	['unknown part kind', { kind: 'audio', file: digest, mediaType: 'audio/wav' }],
])('rejects a malformed part shape: %s', (_case, part) => {
	expect(accepts(SensorPartSchema, part)).toBe(false);
});

it('rejects another wire version and unknown error codes', () => {
	expect(accepts(ObserveRequestSchema, { ...request, api: 2 })).toBe(false);
	expect(accepts(ObserveResponseSchema, { ...response, api: 2 })).toBe(false);
	expect(accepts(SensorIndexSchema, { ...index, api: 2 })).toBe(false);
	expect(accepts(SensorErrorSchema, { ...error, api: 2 })).toBe(false);
	expect(accepts(SensorErrorSchema, { ...error, extra: 'unlisted' })).toBe(false);
});

it.each(['invalid', 'unknown', 'unavailable'])(
	'accepts error code %s in the shared envelope',
	(code) => {
		expect(accepts(SensorErrorSchema, { ...error, code })).toBe(true);
	},
);

it('leaves span ordering to runtime semantics beyond the standalone JSON Schema', () => {
	const reversed = { api: 1, span: { from: to, to: from } };
	expect(accepts(ObserveRequestSchema, reversed)).toBe(true);
	expect(isValidObserveRequest(reversed)).toBe(false);
	expect(isValidObserveRequest({ api: 1, span: { from, to: from } })).toBe(false);
	expect(isValidObserveRequest({ api: 1, span: { from, to } })).toBe(true);
});

it('matches the generated wire schema to the published JSON file', async () => {
	const file = fileURLToPath(new URL('../dist/sensor-api.schema.json', import.meta.url));
	const published = JSON.parse(await readFile(file, 'utf8')) as unknown;
	expect(published).toEqual(SensorApiSchema);
});

it('validates the same samples and rejection cases through the generated JSON Schema', async () => {
	const defs = await publishedDefinitions();
	const sensorIndex = requiredDefinition(defs, 'SensorIndex');
	const observeRequest = requiredDefinition(defs, 'ObserveRequest');
	const observeResponse = requiredDefinition(defs, 'ObserveResponse');
	const sensorPart = requiredDefinition(defs, 'SensorPart');
	const sensorError = requiredDefinition(defs, 'SensorError');
	expect(accepts(sensorIndex, index)).toBe(true);
	expect(accepts(observeRequest, { api: 1 })).toBe(true);
	expect(accepts(observeRequest, request)).toBe(true);
	const reversed = { api: 1, span: { from: to, to: from } };
	expect(accepts(observeRequest, reversed)).toBe(true);
	expect(accepts(observeResponse, response)).toBe(true);
	expect(accepts(observeResponse, { api: 1, observations: [] })).toBe(true);
	expect(accepts(sensorError, error)).toBe(true);
	for (const part of parts) expect(accepts(sensorPart, part)).toBe(true);

	const badIndex = { ...index, sensors: [{ ...index.sensors[0], name: 'dmm\n' }] };
	const badSource = { ...index, source: { ...index.source, commit: `${'b'.repeat(40)}\n` } };
	const badDigest = { ...parts[1], file: `${digest}\n` };
	const badTime = { api: 1, observations: [{ at: '2026-02-30T10:00:00.000Z', parts: [] }] };
	const badInterval = { ...parts[2], intervalMs: Number.POSITIVE_INFINITY };
	expect(accepts(sensorIndex, badIndex)).toBe(false);
	expect(accepts(sensorIndex, badSource)).toBe(false);
	expect(accepts(sensorPart, badDigest)).toBe(false);
	expect(accepts(observeResponse, badTime)).toBe(false);
	expect(accepts(sensorPart, badInterval)).toBe(false);
	expect(accepts(sensorError, { ...error, api: 2 })).toBe(false);
	expect(accepts(sensorError, { ...error, code: 'timeout' })).toBe(false);
	expect(isValidObserveRequest(reversed)).toBe(false);
	expect(isValidObserveRequest({ api: 1, span: { from, to: from } })).toBe(false);
	// The published schema is plain JSON Schema and needs no custom format registry.
	expect(JSON.stringify(defs)).not.toContain('"format"');
});

it('validates all four body types through the complete schema and its parsed published form', async () => {
	const file = fileURLToPath(new URL('../dist/sensor-api.schema.json', import.meta.url));
	const published = JSON.parse(await readFile(file, 'utf8')) as TSchema;
	const roots = [SensorApiSchema as unknown as TSchema, published];
	const bodies = [index, request, response, error];
	const reversed = { api: 1, span: { from: to, to: from } };
	for (const schema of roots) {
		for (const body of bodies) expect(accepts(schema, body)).toBe(true);
		expect(accepts(schema, { ...request, api: 2 })).toBe(false);
		expect(accepts(schema, { ...error, code: 'timeout' })).toBe(false);
		expect(accepts(schema, reversed)).toBe(true);
	}
	expect(isValidObserveRequest(reversed)).toBe(false);
});
