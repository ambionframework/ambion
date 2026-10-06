/** The widget bundle of the canvas: `show`, `hide`, and the reminder of the widgets of a room. */
import { defineTool, type Reminder, type ToolBundle } from '@ambionframework/ambion';
import { Type } from 'typebox';
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
		'Your reminder lists the widgets of the room. The kinds that the host draws:',
		...port.kinds.map(
			(kind) =>
				`- ${kind.name}: ${kind.description} Sources: ${kind.sources.length === 0 ? 'none' : kind.sources.join(', ')}.`,
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
			return `- ${widget.name}: ${widget.kind}${from}, by ${widget.author}, rev ${widget.rev}`;
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
