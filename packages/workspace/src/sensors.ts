/** The versioned JSON wire contract for a sensor server. */
import { type Static, Type } from 'typebox';
import { Check } from 'typebox/value';

/** A lowercase sensor or connection name. */
const name = Type.String({
	description:
		'A name that starts with a lowercase letter and contains lowercase letters, digits, or hyphens.',
	pattern: '^[a-z][a-z0-9-]*(?![\\s\\S])',
});

/** A canonical UTC timestamp with millisecond precision and a real Gregorian date. */
const timestamp = Type.String({
	description: 'A UTC ISO 8601 timestamp with three millisecond digits.',
	pattern:
		'^(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:00|0[48]|[2468][048]|[13579][26])00)-02-29|[0-9]{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8])))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}Z(?![\\s\\S])',
});

/** An agent-owned Git repository identifier. */
const repository = Type.String({
	description: 'An agent-owned Git repository identifier in namespace/name form.',
	pattern: '^(?!templates/)[a-z][a-z0-9-]*/[a-z0-9][a-z0-9._-]{0,63}(?![\\s\\S])',
});

/** A Git branch name that follows the workspace Git name rules. */
const branch = Type.String({
	description: 'A valid Git branch name.',
	pattern:
		'^(?!@(?![\\s\\S]))(?!/)(?![\\s\\S]*//)(?![\\s\\S]*\\/(?![\\s\\S]))(?!\\.)(?![\\s\\S]*\\/\\.)(?![\\s\\S]*\\.\\.)(?![\\s\\S]*@\\{)(?![\\s\\S]*\\.lock(?:/|(?![\\s\\S])))(?![\\s\\S]*\\.(?![\\s\\S]))(?![\\s\\S]*~)(?![\\s\\S]*\\^)(?![\\s\\S]*:)(?![\\s\\S]*\\?)(?![\\s\\S]*\\*)(?![\\s\\S]*\\[)(?![\\s\\S]*\\\\)[^\\x00-\\x20\\x7f]+(?![\\s\\S])',
});

/** A lowercase full SHA-1 or SHA-256 commit hash captured at launch. */
const commit = Type.String({
	description: 'A full lowercase SHA-1 or SHA-256 commit hash.',
	pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})(?![\\s\\S])',
});

/** A lowercase hexadecimal SHA-256 digest. */
const digest = Type.String({
	description: 'A 64-character lowercase hexadecimal SHA-256 digest.',
	pattern: '^[0-9a-f]{64}(?![\\s\\S])',
});

/** A strict source metadata schema. */
export const SensorSourceSchema = Type.Object(
	{
		repository,
		commit,
		branch: Type.Optional(branch),
		dirty: Type.Boolean(),
	},
	{ additionalProperties: false },
);

/** A strict server index schema. */
export const SensorIndexSchema = Type.Object(
	{
		api: Type.Literal(1),
		source: SensorSourceSchema,
		sensors: Type.Array(
			Type.Object(
				{
					name,
					description: Type.String(),
					spans: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/** A strict half-open span schema. */
export const SensorSpanSchema = Type.Object(
	{ from: timestamp, to: timestamp },
	{ additionalProperties: false },
);

/** A strict observation request schema. */
export const ObserveRequestSchema = Type.Object(
	{ api: Type.Literal(1), span: Type.Optional(SensorSpanSchema) },
	{
		additionalProperties: false,
		description:
			'When span is present, from must precede to. Use isValidObserveRequest for this cross-field check.',
	},
);

/** A strict sensor part schema. */
export const SensorPartSchema = Type.Union([
	Type.Object({ kind: Type.Literal('text'), text: Type.String() }, { additionalProperties: false }),
	Type.Object(
		{
			kind: Type.Literal('frame'),
			file: digest,
			mediaType: Type.Union([Type.Literal('image/jpeg'), Type.Literal('image/png')]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal('series'),
			channel: Type.String(),
			unit: Type.String(),
			from: timestamp,
			intervalMs: Type.Number({ exclusiveMinimum: 0 }),
			values: Type.Array(Type.Number()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal('file'),
			file: digest,
			name: Type.String(),
			mediaType: Type.String(),
		},
		{ additionalProperties: false },
	),
]);

/** A strict observation response schema. */
export const ObserveResponseSchema = Type.Object(
	{
		api: Type.Literal(1),
		observations: Type.Array(
			Type.Object(
				{ at: timestamp, parts: Type.Array(SensorPartSchema) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/** A strict sensor error envelope schema. */
export const SensorErrorSchema = Type.Object(
	{
		api: Type.Literal(1),
		code: Type.Union([
			Type.Literal('invalid'),
			Type.Literal('unknown'),
			Type.Literal('unavailable'),
		]),
		message: Type.String(),
	},
	{ additionalProperties: false },
);

/** Recursively makes a TypeBox-derived client type read-only. */
type DeepReadonly<T> = T extends readonly (infer U)[]
	? readonly DeepReadonly<U>[]
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;

/** Launch source metadata captured by the sensor server. */
export type SensorSource = DeepReadonly<Static<typeof SensorSourceSchema>>;

/** The server index returned by `GET /`. */
export type SensorIndex = DeepReadonly<Static<typeof SensorIndexSchema>>;

/** A half-open observation span. */
export type SensorSpan = DeepReadonly<Static<typeof SensorSpanSchema>>;

/** The request body for `POST /<sensor>/observe`. */
export type ObserveRequest = DeepReadonly<Static<typeof ObserveRequestSchema>>;

/** A text, image frame, numeric series, or file part. */
export type SensorPart = DeepReadonly<Static<typeof SensorPartSchema>>;

/** One observation and its source-timestamped parts. */
export type SensorObservation = ObserveResponse['observations'][number];

/** The successful response body for an observation request. */
export type ObserveResponse = DeepReadonly<Static<typeof ObserveResponseSchema>>;

/** The error response body returned by any sensor endpoint. */
export type SensorError = DeepReadonly<Static<typeof SensorErrorSchema>>;

/** The complete wire schema, serialized to the package's JSON schema entry. */
export const SensorApiSchema = {
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	title: 'Ambion Sensor API version 1',
	$defs: {
		SensorSource: SensorSourceSchema,
		SensorIndex: SensorIndexSchema,
		SensorSpan: SensorSpanSchema,
		ObserveRequest: ObserveRequestSchema,
		ObserveResponse: ObserveResponseSchema,
		SensorPart: SensorPartSchema,
		SensorError: SensorErrorSchema,
	},
	oneOf: [
		{ $ref: '#/$defs/SensorIndex' },
		{ $ref: '#/$defs/ObserveRequest' },
		{ $ref: '#/$defs/ObserveResponse' },
		{ $ref: '#/$defs/SensorError' },
	],
} as const;

/** Whether `value` is a valid observation request, including increasing spans. */
export function isValidObserveRequest(value: unknown): value is ObserveRequest {
	if (!Check(ObserveRequestSchema, value)) return false;
	if (value.span === undefined) return true;
	return value.span.from < value.span.to;
}

export {
	createSensorClient,
	type SensorClient,
	SensorDigestError,
	type SensorFile,
	SensorHttpError,
	SensorProtocolError,
} from './sensor-client.ts';
