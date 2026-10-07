/**
 * The declared outputs of the process tools, as TypeBox schemas. Each
 * `compose` binding of `bash`, `cancel`, `wait`, and `ps` returns
 * `details` that match one of them. The details types of the tools are the
 * `Static` types of these schemas, so a schema and its type cannot drift.
 */

import { type Static, Type } from 'typebox';

const ProcessState = Type.Union([
	Type.Literal('running'),
	Type.Literal('exited'),
	Type.Literal('timed_out'),
	Type.Literal('cancelled'),
	Type.Literal('failed'),
]);

/** The schema of `Process`. A type test pins that the two stay assignable. */
export const ProcessFacts = Type.Object(
	{
		handle: Type.String({ description: 'The key of the process, such as bash-1a2b3c4d5e6f.' }),
		name: Type.Optional(Type.String({ description: 'The label that bash was given, if any.' })),
		kind: Type.Literal('bash'),
		agent: Type.String({ description: 'The agent that started the process.' }),
		command: Type.String({ description: 'The command, as it was given.' }),
		port: Type.Integer({
			description: 'The port that the workspace set in $PORT for the command. Zero means none.',
		}),
		state: ProcessState,
		output: Type.String({
			description: 'The absolute path of the file that holds the whole output.',
		}),
		timeout: Type.Number({
			description: 'Seconds the process may run before the table cancels it.',
		}),
		grace: Type.Number({ description: 'Seconds from SIGTERM to SIGKILL on a cancel.' }),
		room: Type.Optional(
			Type.String({ description: 'The room of the call that started the process, if any.' }),
		),
		startedAt: Type.String({ description: 'The start time, as an ISO 8601 timestamp.' }),
		endedAt: Type.Optional(
			Type.String({
				description: 'The end time, as an ISO 8601 timestamp. Set when the state is final.',
			}),
		),
		exitCode: Type.Optional(Type.Integer({ description: 'Set when the state is exited.' })),
		error: Type.Optional(Type.String({ description: 'Set when the state is failed.' })),
		stopping: Type.Optional(
			Type.Boolean({ description: 'True while a cancel waits for the end of a running process.' }),
		),
	},
	{ $id: 'Process', description: 'The facts of one process.' },
);

/** The schema of `ShellOutputTruncation`. A type test pins that the two stay assignable. */
export const TruncationFacts = Type.Object(
	{
		truncated: Type.Boolean({ description: 'True when the view holds less than the whole text.' }),
		truncatedBy: Type.Union([Type.Literal('lines'), Type.Literal('bytes'), Type.Null()], {
			description: 'The limit that the cut reached first, or null for no cut.',
		}),
		totalLines: Type.Integer({
			description: 'The lines of the whole text. For `read`, the lines that the scan saw.',
		}),
		totalBytes: Type.Integer({
			description: 'The bytes of the whole text. For `read`, the bytes that the scan saw.',
		}),
		outputLines: Type.Integer({ description: 'The lines that the view holds.' }),
		outputBytes: Type.Integer({ description: 'The bytes that the view holds.' }),
		lastLinePartial: Type.Boolean({
			description: 'True when the first line of the view is the end of a longer line.',
		}),
		firstLineExceedsLimit: Type.Boolean({
			description: 'True when the first line alone exceeds the byte limit.',
		}),
		maxLines: Type.Integer({ description: 'The line limit of the cut.' }),
		maxBytes: Type.Integer({ description: 'The byte limit of the cut.' }),
	},
	{ $id: 'Truncation', description: 'What a cut kept, and what the whole text held.' },
);

/** One process, the new output that the result shows, and the cut of that view. */
export const ProcessOutput = Type.Object(
	{
		process: ProcessFacts,
		text: Type.String({
			description: 'The new output that this result shows. Empty when there is none.',
		}),
		read: Type.Object(
			{
				from: Type.Integer({
					description: 'The byte offset in the output file where this result starts.',
				}),
				to: Type.Integer({
					description: 'The byte offset in the output file where this result ends.',
				}),
			},
			{ description: 'The bytes of the output file that this result covers.' },
		),
		truncation: Type.Optional(TruncationFacts),
		omitted: Type.Optional(
			Type.Object(
				{
					offset: Type.Integer({
						description:
							'The first line that the view leaves out, counted from 1, as `read` takes it.',
					}),
					limit: Type.Integer({
						description: 'The lines that the view leaves out, as the `limit` of `read`.',
					}),
				},
				{
					description:
						'The lines of the output file between the start and the end that a cut view shows. Absent when the view is whole.',
				},
			),
		),
	},
	{ $id: 'ProcessResult', description: 'One process, and the new output of its result.' },
);

/** What `wait` on several handles gives: every state in the order of the handles, and each process it shows. */
const WaitedOutput = Type.Object(
	{
		processes: Type.Array(ProcessFacts, {
			description: 'Every process, in the order of the handles.',
		}),
		ended: Type.Array(ProcessOutput, {
			description: 'The result of each process that ended and fit the result.',
		}),
	},
	{ $id: 'WaitedResult' },
);

/** What `wait` gives: the result of `bash` for one handle, and `WaitedOutput` for several. */
export const WaitOutput = Type.Union([ProcessOutput, WaitedOutput], { $id: 'WaitResult' });

/** The running processes of the caller. */
export const PsOutput = Type.Object({ processes: Type.Array(ProcessFacts) }, { $id: 'PsResult' });

/** What a handle tool gives in `details`. */
export type ProcessDetails = Static<typeof ProcessOutput>;

/** What `wait` on several handles gives in `details`. */
export type WaitDetails = Static<typeof WaitedOutput>;

/** What `ps` gives in `details`. */
export type PsDetails = Static<typeof PsOutput>;
