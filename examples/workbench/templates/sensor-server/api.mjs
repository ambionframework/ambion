// The wire contract of this sensor server, protocol version 2.
//
//   GET /                                 the index: api, source, sensors
//   GET /<sensor>/observe[?from=&to=]     the observations, latest or for a span
//   GET /files/<sha256>                   immutable bytes
//
// A breaking change raises `API`. The `observe` macro of this template refuses
// a server at another `API`. Every timestamp is UTC with three millisecond
// digits. A span is half open: `from` is in and `to` is out.
import { Type } from 'typebox';
import { Check } from 'typebox/value';

/** The protocol version. */
export const API = 2;

/** A lowercase sensor name. */
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
export const SourceSchema = Type.Object(
	{
		repository,
		commit,
		branch: Type.Optional(branch),
		dirty: Type.Boolean(),
	},
	{ additionalProperties: false },
);

/** A strict index schema, the body of `GET /`. */
export const IndexSchema = Type.Object(
	{
		api: Type.Literal(API),
		source: SourceSchema,
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

/** The query of an observe request. `from` and `to` come together, and `from` precedes `to`. */
export const QuerySchema = Type.Object(
	{ from: Type.Optional(timestamp), to: Type.Optional(timestamp) },
	{ additionalProperties: false },
);

/** A strict part schema. */
export const PartSchema = Type.Union([
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

/** A strict response schema, the body of `GET /<sensor>/observe`. */
export const ObserveSchema = Type.Object(
	{
		api: Type.Literal(API),
		observations: Type.Array(
			Type.Object(
				{ at: timestamp, parts: Type.Array(PartSchema) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/** A strict error response schema, the body of every non-200 reply. */
export const ErrorSchema = Type.Object(
	{
		api: Type.Literal(API),
		code: Type.Union([
			Type.Literal('invalid'),
			Type.Literal('unknown'),
			Type.Literal('unavailable'),
		]),
		message: Type.String(),
	},
	{ additionalProperties: false },
);

/**
 * The span of a query, or the reason it is invalid. The result is
 * `{ span }` with no span for a latest read, or `{ error }`.
 */
export function spanOf(params) {
	const keys = [...params.keys()];
	const query = Object.fromEntries(params);
	if (new Set(keys).size !== keys.length || !Check(QuerySchema, query))
		return { error: 'The query must be empty or hold one from and one to, as UTC timestamps.' };
	const { from, to } = query;
	if (from === undefined && to === undefined) return {};
	if (from === undefined || to === undefined) return { error: 'The query needs both from and to.' };
	if (from >= to) return { error: 'The span must start before it ends.' };
	return { span: { from, to } };
}
