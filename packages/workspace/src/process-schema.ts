/**
 * The declared outputs of the process tools, as TypeBox schemas. Each
 * `compose` binding of `bash`, `status`, `cancel`, `wait`, and `ps` returns
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
export const ProcessFacts = Type.Object({
	handle: Type.String(),
	name: Type.Optional(Type.String()),
	kind: Type.Literal('bash'),
	agent: Type.String(),
	command: Type.String(),
	state: ProcessState,
	output: Type.String({
		description: 'The absolute path of the file that holds the whole output.',
	}),
	timeout: Type.Number({ description: 'Seconds the process may run before the table cancels it.' }),
	grace: Type.Number({ description: 'Seconds from SIGTERM to SIGKILL on a cancel.' }),
	room: Type.Optional(Type.String()),
	startedAt: Type.String(),
	endedAt: Type.Optional(Type.String()),
	exitCode: Type.Optional(Type.Integer()),
	error: Type.Optional(Type.String()),
	stopping: Type.Optional(Type.Boolean()),
});

/** The schema of `ShellOutputTruncation`. A type test pins that the two stay assignable. */
export const TruncationFacts = Type.Object({
	truncated: Type.Boolean(),
	truncatedBy: Type.Union([Type.Literal('lines'), Type.Literal('bytes'), Type.Null()]),
	totalLines: Type.Integer(),
	totalBytes: Type.Integer(),
	outputLines: Type.Integer(),
	outputBytes: Type.Integer(),
	lastLinePartial: Type.Boolean(),
	firstLineExceedsLimit: Type.Boolean(),
	maxLines: Type.Integer(),
	maxBytes: Type.Integer(),
});

/** One process, the bytes of its output that the result shows, and the cut of that view. */
export const ProcessOutput = Type.Object({
	process: ProcessFacts,
	read: Type.Object({
		from: Type.Integer(),
		to: Type.Integer(),
	}),
	truncation: Type.Optional(TruncationFacts),
});

/** What `wait` on several handles gives: every status in the order of the handles, and each process it shows. */
const WaitedOutput = Type.Object({
	processes: Type.Array(ProcessFacts),
	ended: Type.Array(ProcessOutput),
});

/** What `wait` gives: the output of `status` for one handle, and `WaitedOutput` for several. */
export const WaitOutput = Type.Union([ProcessOutput, WaitedOutput]);

/** The running processes of the caller. */
export const PsOutput = Type.Object({ processes: Type.Array(ProcessFacts) });

/** What a handle tool gives in `details`. */
export type ProcessDetails = Static<typeof ProcessOutput>;

/** What `wait` on several handles gives in `details`. */
export type WaitDetails = Static<typeof WaitedOutput>;

/** What `ps` gives in `details`. */
export type PsDetails = Static<typeof PsOutput>;
