/** The two bundles of the canvas: the opener bundle, and the worker bundle. */
import {
	defineTool,
	type ToolBundle,
	type ToolContext,
	type ToolResult,
} from '@ambionframework/ambion';
import { Type } from 'typebox';
import { archiveRoom, type BreakoutPort, callerOf, openBreakout, tellRoom } from './breakout.ts';
import { breakoutReminder } from './reminder.ts';
import { reportToParent } from './report.ts';

const Result = Type.Union([Type.Literal('done'), Type.Literal('failed')]);

const BreakoutOutput = Type.Object({
	room: Type.String({ description: 'The full name of the room.' }),
	uri: Type.String({ description: 'The URI of the room.' }),
	mirror: Type.Optional(Type.String({ description: 'The path of the mirror file of the room.' })),
	state: Type.Union([Type.Literal('running'), Type.Literal('stopped'), Type.Literal('archived')]),
	created: Type.Boolean({
		description: 'False when the call returned a room that already existed.',
	}),
	close: Type.Optional(
		Type.Object(
			{ result: Result, note: Type.Optional(Type.String()) },
			{ description: 'The close of an archived room.' },
		),
	),
});

const TellOutput = Type.Object({
	room: Type.String(),
	from: Type.Integer({ description: 'The seq of the message that the post landed as.' }),
});

const ArchiveOutput = Type.Object({
	room: Type.String(),
	result: Result,
	note: Type.Optional(Type.String()),
});

const ReportOutput = Type.Object({
	room: Type.String({ description: 'The parent room.' }),
	from: Type.Integer({ description: 'The seq of the message that the report landed as.' }),
	to: Type.Optional(Type.String({ description: 'The opener, when the report went to it.' })),
});

const text = <T>(summary: string, details: T): ToolResult<T> => ({
	content: [{ type: 'text', text: summary }],
	details,
});

const OPENER_GUIDANCE = [
	'A breakout room is a room of its own for background work. Its workers come from the worker team.',
	'`breakout` opens one with a goal and a first message. A repeat call with the same name returns the same room.',
	'A task that you delegate goes to the breakout room alone. Do not seat a specialist of this room, and do not ask one, for that task.',
	'`tell` posts into a breakout room that you opened, and steers its workers.',
	'`archive` ends a breakout room, and records `done` or `failed`. An archived room does not start again.',
	'A report of the workers arrives in this room as a message that starts with `breakout <room>:`. When the report arrives, archive the room as `done` or `failed`, and answer the person who asked with the result. A close notice with the same start carries no result: use `tell` to ask the workers again.',
	'Your reminder lists the breakout rooms that you hold. Read it before you say that a room failed.',
].join('\n');

const WORKER_GUIDANCE =
	'`report` posts your result into the room that opened yours. Call it inside the exchange that activated you.';

/** The opener bundle: `breakout`, `tell`, `archive`, and the reminder. */
export function openerBundle(port: BreakoutPort): ToolBundle {
	return {
		tools: [
			defineTool({
				name: 'breakout',
				label: 'Open a breakout room',
				description:
					'Open a breakout room only when it is valuable: for independent work that runs in parallel while this room continues, or for a narrow task that would distract this room. Else answer in this room, or ask a specialist of this room. The tool opens the breakout room <your room>-<name> with a goal. Seat workers from the team, and post the first message to one worker or to all. A repeat call with the same name returns the room that you opened.',
				parameters: Type.Object({
					name: Type.String({
						description: 'The room is <your room>-<name>, at most 48 characters.',
					}),
					goal: Type.String({ description: 'The goal of the room.' }),
					message: Type.String({ description: 'The first message. It opens the first exchange.' }),
					agents: Type.Array(Type.String(), {
						description: 'One or more names from the worker team.',
					}),
					to: Type.Optional(
						Type.String({ description: 'One worker. Omit it to post to every worker.' }),
					),
				}),
				compose: { output: BreakoutOutput },
				execute: async (params, ctx) => {
					const result = await openBreakout(port, callerOf(port, ctx), params);
					const verb = result.created ? 'Opened' : 'Found';
					return text(`${verb} the breakout room "${result.room}": ${result.state}.`, result);
				},
			}),
			defineTool({
				name: 'tell',
				label: 'Tell a breakout room',
				description: 'Post a message into a running breakout room that you opened.',
				parameters: Type.Object({
					room: Type.String({ description: 'The full name of a breakout room that you opened.' }),
					text: Type.String(),
					to: Type.Optional(
						Type.String({ description: 'One worker. Omit it to post to every worker.' }),
					),
					refs: Type.Optional(Type.Array(Type.String())),
				}),
				compose: { output: TellOutput },
				execute: async (params, ctx) => {
					const result = await tellRoom(port, callerOf(port, ctx), params);
					return text(`Posted into "${result.room}" as message #${result.from}.`, result);
				},
			}),
			defineTool({
				name: 'archive',
				label: 'Archive a breakout room',
				description:
					'Stop a breakout room that you opened, and record its result. An archived room does not start again.',
				parameters: Type.Object({
					room: Type.String({ description: 'The full name of a breakout room that you opened.' }),
					result: Result,
					note: Type.Optional(Type.String()),
				}),
				compose: { output: ArchiveOutput },
				execute: async (params, ctx) => {
					const result = await archiveRoom(port, callerOf(port, ctx), params);
					return text(`Archived "${result.room}" as ${result.result}.`, result);
				},
			}),
		],
		guidance: OPENER_GUIDANCE,
		remind: breakoutReminder(port),
	};
}

/** The worker bundle: `report`. */
export function workerBundle(port: BreakoutPort): ToolBundle {
	return {
		tools: [
			defineTool({
				name: 'report',
				label: 'Report to the opener',
				description:
					'Post a result into the room that opened your room, to the agent that opened it. Call it inside the exchange that activated you.',
				parameters: Type.Object({
					text: Type.String({ description: 'The result.' }),
					refs: Type.Optional(Type.Array(Type.String())),
				}),
				compose: { output: ReportOutput },
				execute: async (params, ctx: ToolContext) => {
					const result = await reportToParent(port, callerOf(port, ctx), params);
					return text(`Reported into "${result.room}" as message #${result.from}.`, result);
				},
			}),
		],
		guidance: WORKER_GUIDANCE,
	};
}
