/** The widget bundle of the canvas: `show`, `hide`, and the reminder of the widgets of a room. */
import { defineTool, type Reminder, type ToolBundle } from '@ambionframework/ambion';
import { Type } from 'typebox';
import { ACTIONS_LIMIT, FIELDS_LIMIT, LABEL_LIMIT, OPTIONS_LIMIT, TEXT_LIMIT } from './actions.ts';
import { callerOf } from './breakout.ts';
import { NAME_LIMIT, reminderLines, text } from './port.ts';
import {
	hideWidget,
	showWidget,
	sourceText,
	WIDGET_TITLE_LIMIT,
	type WidgetPort,
} from './widgets.ts';

const Source = Type.Union(
	[
		Type.Object(
			{
				type: Type.Literal('process'),
				handle: Type.String({
					description:
						'The handle of one of your running processes, from the bash result or the process reminder.',
				}),
				path: Type.String({
					description: 'The path that the process serves on its port, such as /status.',
				}),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{ type: Type.Literal('file'), path: Type.String({ description: 'The path of a file.' }) },
			{ additionalProperties: false },
		),
		Type.Object(
			{
				type: Type.Literal('snapshot'),
				ref: Type.String({ description: 'The ref of a snapshot.' }),
			},
			{ additionalProperties: false },
		),
	],
	{ description: 'Where the data of the widget comes from.' },
);

const Field = Type.Union(
	[
		Type.Object(
			{ name: Type.String(), label: Type.String(), type: Type.Literal('text') },
			{ additionalProperties: false },
		),
		Type.Object(
			{
				name: Type.String(),
				label: Type.String(),
				type: Type.Literal('number'),
				min: Type.Optional(Type.Number()),
				max: Type.Optional(Type.Number()),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{ name: Type.String(), label: Type.String(), type: Type.Literal('boolean') },
			{ additionalProperties: false },
		),
		Type.Object(
			{
				name: Type.String(),
				label: Type.String(),
				type: Type.Literal('choice'),
				options: Type.Array(Type.String()),
			},
			{ additionalProperties: false },
		),
	],
	{
		description: `A field of a form. A text value is one line of ${TEXT_LIMIT} characters at most. A choice has 1 to ${OPTIONS_LIMIT} options of ${LABEL_LIMIT} characters at most.`,
	},
);

const Action = Type.Object(
	{
		id: Type.String({ description: 'The name of the action, such as keep.' }),
		label: Type.String({ description: `One line, at most ${LABEL_LIMIT} characters.` }),
		once: Type.Optional(
			Type.Boolean({
				description: 'The first act on this revision answers it. Every later act is answered.',
			}),
		),
		fields: Type.Optional(
			Type.Array(Field, { description: `A form of at most ${FIELDS_LIMIT} fields.` }),
		),
	},
	{ additionalProperties: false },
);

const WidgetOutput = Type.Object({
	room: Type.String(),
	name: Type.String(),
	revision: Type.String({ description: 'The id of the current revision.' }),
	rev: Type.Integer({ description: 'The count of revisions of this name.' }),
	state: Type.Union([Type.Literal('shown'), Type.Literal('hidden')]),
	changed: Type.Boolean({
		description: 'False when the call found the widget as it was and wrote nothing.',
	}),
});

function guidance(port: WidgetPort): string {
	return [
		'A widget is a live view that you place in this room for people. The host draws it, and you pay no activation for it.',
		'`show` places a widget by name, or changes its content. A repeat `show` with the same content changes nothing.',
		'`hide` removes a widget from view. A hidden widget does not stop its source: cancel the process to stop it.',
		'`show` takes `actions` on a kind that allows them. A person who presses an action sends you a message with the widget, its rev, the label, the action id, and the field values. `for` names the one person who may act.',
		'A widget with actions asks a question. Show it, say to the person what you need, and end your activation. The press arrives as a later message. An action with `once` takes the first press of a revision, and your reminder names who answered. To ask again, change the content or pick a new name.',
		'Your reminder lists the widgets of the room. The kinds that the host draws:',
		...port.kinds.map(
			(kind) =>
				`- ${kind.name}: ${kind.description} Sources: ${kind.sources.length === 0 ? 'none' : kind.sources.join(', ')}. Actions: ${kind.actions ? 'yes' : 'no'}.`,
		),
	].join('\n');
}

/** The reminder text: the shown widgets of the room of the seat. */
function widgetReminder(port: WidgetPort): Reminder {
	return async (seat) => {
		const shown = port.widgets(seat.room).filter((widget) => widget.state === 'shown');
		if (shown.length === 0) return undefined;
		const lines = await reminderLines(shown, (widget) => {
			const from = widget.source === undefined ? '' : ` from ${sourceText(widget.source)}`;
			const person = widget.for === undefined ? '' : ` for ${widget.for}`;
			const answer = port.answer(widget.room, widget.revision);
			const answered = answer === undefined ? '' : `, answered by ${answer.by} in #${answer.seq}`;
			return `- ${widget.name}: ${widget.kind}${from}${person}, by ${widget.author}, rev ${widget.rev}${answered}`;
		});
		return ['Widgets in this room:', ...lines].join('\n');
	};
}

/** The widget bundle: `show`, `hide`, and the reminder. */
export function widgetBundle(port: WidgetPort): ToolBundle {
	return {
		tools: [
			defineTool({
				name: 'show',
				label: 'Show a widget',
				description: `Place the widget <name> in this room, or change its content. The name has at most ${NAME_LIMIT} characters. A repeat call with the same content changes nothing.`,
				parameters: Type.Object(
					{
						name: Type.String({ description: 'The name of the widget, such as viewfinder.' }),
						kind: Type.String({ description: 'One kind of the catalog.' }),
						source: Type.Optional(Source),
						title: Type.Optional(
							Type.String({ description: `One line, at most ${WIDGET_TITLE_LIMIT} characters.` }),
						),
						actions: Type.Optional(
							Type.Array(Action, {
								description: `What a person can do on the widget, ${ACTIONS_LIMIT} actions at most. Only a kind that allows actions takes them.`,
							}),
						),
						for: Type.Optional(
							Type.String({
								description:
									'The one person who may act, by name. Absent: any person in the room may act.',
							}),
						),
					},
					{ additionalProperties: false },
				),
				compose: { output: WidgetOutput },
				execute: async (params, ctx) => {
					const result = await showWidget(port, callerOf(port, ctx), params);
					const summary = result.changed
						? `Showed the widget "${result.name}", rev ${result.rev}.`
						: `The widget "${result.name}" shows this content already, rev ${result.rev}.`;
					return text(summary, result);
				},
			}),
			defineTool({
				name: 'hide',
				label: 'Hide a widget',
				description:
					'Hide the widget <name> of this room. A hidden widget changes nothing. Its source keeps running.',
				parameters: Type.Object(
					{
						name: Type.String({ description: 'The name of a widget of this room.' }),
					},
					{ additionalProperties: false },
				),
				compose: { output: WidgetOutput },
				execute: async (params, ctx) => {
					const result = await hideWidget(port, callerOf(port, ctx), params);
					const summary = result.changed
						? `Hid the widget "${result.name}", rev ${result.rev}.`
						: `The widget "${result.name}" is hidden already, rev ${result.rev}.`;
					return text(summary, result);
				},
			}),
		],
		guidance: guidance(port),
		remind: widgetReminder(port),
	};
}
