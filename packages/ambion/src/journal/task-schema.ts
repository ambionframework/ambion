/** Stored Task facts use the same validation in authority entries and delivered pins. */
import { Type } from 'typebox';

const text = Type.String({ minLength: 1 });
const seq = Type.Integer({ minimum: 0 });
const extra = { additionalProperties: false } as const;
const taskStatus = Type.Union(['open', 'succeeded', 'failed'].map((value) => Type.Literal(value)));
const terminal = Type.Union(['succeeded', 'failed'].map((value) => Type.Literal(value)));
const eventTypes = Type.Union(
	['created', 'updated', 'idle', 'instructed'].map((value) => Type.Literal(value)),
);
const taskFields = {
	id: text,
	text,
	owner: text,
	originRoom: text,
	exchange: seq,
	workingRoom: text,
	agents: Type.Array(text, { minItems: 1 }),
	status: taskStatus,
	subscriptions: Type.Array(
		Type.Object({ room: text, agent: text, progress: Type.Boolean() }, extra),
	),
	outcome: Type.Optional(text),
	createdAt: text,
};
const taskRecord = Type.Object(taskFields, extra);
export const taskView = Type.Object(
	{
		...taskFields,
		events: Type.Array(
			Type.Object(
				{
					id: text,
					task: text,
					type: eventTypes,
					status: taskStatus,
					sourceRoom: text,
					at: text,
					text: Type.Optional(text),
					outcome: Type.Optional(text),
					author: Type.Optional(text),
					idleEpoch: Type.Optional(seq),
				},
				extra,
			),
		),
	},
	extra,
);
const delivery = Type.Object(
	{
		id: text,
		room: text,
		from: text,
		to: Type.Optional(text),
		text,
		task: taskView,
		sourceRoom: text,
		wake: Type.Boolean(),
	},
	extra,
);
const common = { event: text, at: text };
const event = { ...common, sourceRoom: text, deliveries: Type.Array(delivery) };
const operation = Type.Object(
	{
		id: text,
		kind: Type.Union([Type.Literal('update'), Type.Literal('instruct')]),
		task: text,
		sourceRoom: text,
		author: text,
		version: text,
		text,
		status: Type.Optional(terminal),
	},
	extra,
);
const taskResult = Type.Union([
	Type.Object({ task: text, room: text, status: taskStatus }, extra),
	Type.Object({ refused: text, task: Type.Optional(taskView) }, extra),
]);
export const taskChange = Type.Union([
	Type.Object({ ...common, type: Type.Literal('cancelling'), exchange: seq }, extra),
	Type.Object({ ...event, type: Type.Literal('created'), task: taskRecord, author: text }, extra),
	Type.Object(
		{
			...event,
			type: Type.Literal('updated'),
			task: text,
			text,
			status: taskStatus,
			outcome: Type.Optional(text),
			author: Type.Optional(text),
		},
		extra,
	),
	Type.Object(
		{ ...event, type: Type.Literal('instructed'), task: text, text, author: text },
		extra,
	),
	Type.Object({ ...event, type: Type.Literal('idle'), task: text, epoch: seq }, extra),
	Type.Object(
		{
			...common,
			type: Type.Literal('delivered'),
			delivery: text,
			seq,
			failure: Type.Optional(text),
		},
		extra,
	),
	Type.Object({ ...common, type: Type.Literal('operation'), operation }, extra),
	Type.Object(
		{ ...common, type: Type.Literal('operation-result'), operation: text, result: taskResult },
		extra,
	),
]);
