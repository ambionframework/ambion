/**
 * Kestrel Yard, Block C — a construction management suite where each product
 * is an agent.
 *
 * Three products hold their own state and their own API and know nothing of
 * each other's internals: they ask on the record, the way a person does. Three
 * people share the workspace from a site office, a phone on the deck and a
 * cost desk, and each one brings an aide that holds what they act on and
 * writes the one message they read.
 *
 * `main.ts` opens this interactively. `demo.ts` drives one scripted run of it.
 */
import {
	attentive,
	defineAgent,
	defineHuman,
	defineTool,
	type HumanDefinition,
} from '@ambionframework/ambion';
import { Type } from 'typebox';

export const MODEL = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
export const WORKSPACE = 'kestrel-yard-block-c';

export const GOAL = `
	Deliver Block C at Kestrel Yard on programme and to spec. The Level 3 slab
	pour is the next milestone and it is currently blocked. Keep the task list,
	the materials position and the labour plan consistent with what the site
	actually decides.
`;

// -- the products' state -----------------------------------------------------

export const shiftsState = {
	week: 'w/c Mon 24 Aug',
	today: 'Tue 25 Aug',
	overtimeThresholdHrs: 45,
	weekendRate: '1.5× Saturday, 2× Sunday',
	crew: [
		{
			trade: 'Concrete',
			people: 6,
			hoursThisWeek: 41,
			onSiteToday: 6,
			tickets: ['pour supervision', 'power float'],
		},
		{
			trade: 'Steel fixers',
			people: 4,
			hoursThisWeek: 38,
			onSiteToday: 4,
			tickets: ['rebar fixing'],
		},
		{
			trade: 'Formwork',
			people: 5,
			hoursThisWeek: 44,
			onSiteToday: 3,
			tickets: ['falsework', 'striking'],
		},
		{
			trade: 'Groundworks',
			people: 3,
			hoursThisWeek: 22,
			onSiteToday: 0,
			tickets: ['plant operation', 'pump operation'],
		},
	],
	overtimeRequests: [] as {
		trade: string;
		date: string;
		hours: number;
		reason: string;
		state: string;
	}[],
};

export interface Task {
	id: string;
	title: string;
	status: 'open' | 'blocked' | 'done' | 'rescheduled';
	owner: string;
	due: string;
	blockedBy: string[];
	note?: string;
}

export const tasksState: Task[] = [
	{
		id: 'T-118',
		title: 'Level 3 slab pour',
		status: 'blocked',
		owner: 'sam',
		due: 'Thu 27 Aug',
		blockedBy: ['T-121', 'T-130'],
	},
	{
		id: 'T-121',
		title: 'Pre-pour rebar inspection (building control)',
		status: 'blocked',
		owner: 'priya',
		due: 'Wed 26 Aug',
		blockedBy: ['T-126'],
		note: 'Inspector slot needs 48h notice — not booked',
	},
	{
		id: 'T-126',
		title: 'Rebar fixing complete, Level 3',
		status: 'open',
		owner: 'sam',
		due: 'Tue 25 Aug',
		blockedBy: ['T-133'],
	},
	{
		id: 'T-133',
		title: 'Receive 16mm rebar (D-4471)',
		status: 'open',
		owner: 'sam',
		due: 'Wed 26 Aug',
		blockedBy: [],
	},
	{
		id: 'T-130',
		title: 'Confirm concrete pump hire',
		status: 'open',
		owner: 'dan',
		due: 'Tue 25 Aug',
		blockedBy: [],
	},
	{
		id: 'T-124',
		title: 'Formwork strike, Level 2',
		status: 'open',
		owner: 'sam',
		due: 'Fri 28 Aug',
		blockedBy: [],
	},
	{
		id: 'T-097',
		title: 'Level 2 slab pour',
		status: 'done',
		owner: 'sam',
		due: 'Thu 13 Aug',
		blockedBy: [],
	},
];

export const materialsState = {
	stock: [
		{ item: 'Rebar B500B 16mm', unit: 't', onSite: 4.2, required: 11.7, onOrder: 7.5 },
		{ item: 'Rebar B500B 12mm', unit: 't', onSite: 2.1, required: 1.8, onOrder: 0 },
		{ item: 'C32/40 concrete', unit: 'm³', onSite: 0, required: 96, onOrder: 96 },
		{ item: 'Spacers / chairs', unit: 'box', onSite: 14, required: 9, onOrder: 0 },
	],
	deliveries: [
		{
			ref: 'D-4471',
			item: 'Rebar B500B 16mm',
			qty: '7.5 t',
			supplier: 'Hadley Steel',
			eta: 'Wed 26 Aug, 14:00',
			state: 'confirmed',
		},
		{
			ref: 'D-4488',
			item: 'C32/40 concrete',
			qty: '96 m³',
			supplier: 'Trent Ready-Mix',
			eta: 'Thu 27 Aug, 07:00',
			state: 'provisional',
		},
	],
	suppliers: [
		{
			name: 'Hadley Steel',
			lead: '3 working days',
			terms:
				'Slot moves free with 24h notice. A missed booked slot re-queues to the back of the week.',
		},
		{
			name: 'Trent Ready-Mix',
			lead: '24h lock-in',
			terms:
				'Orders lock 24 hours before the slot. Cancelled inside the lock is charged at 60% of the load. Moving outside the window is free.',
		},
	],
};

/** Every call any product makes, so a host can show its API traffic. */
export const apiLog: { app: string; tool: string; params: unknown; result: string }[] = [];
const log = (app: string, tool: string, params: unknown, result: string) => {
	apiLog.push({ app, tool, params, result });
	return result;
};

// -- the time tracker's API --------------------------------------------------

const crewHours = defineTool({
	name: 'crew_hours',
	description: 'Hours logged per trade this week, who is on site today, and overtime exposure.',
	parameters: Type.Object({}),
	execute: () =>
		log(
			'time-tracker',
			'crew_hours',
			{},
			`${shiftsState.week}, today is ${shiftsState.today}. Threshold ${shiftsState.overtimeThresholdHrs}h/person. Weekend ${shiftsState.weekendRate}.\n` +
				shiftsState.crew
					.map(
						(c) =>
							`${c.trade}: ${c.people} on the books, ${c.hoursThisWeek}h logged, ${c.onSiteToday} on site today`,
					)
					.join('\n') +
				(shiftsState.overtimeRequests.length
					? `\nOvertime raised: ${shiftsState.overtimeRequests.map((r) => `${r.trade} ${r.date} +${r.hours}h (${r.state})`).join('; ')}`
					: '\nNo overtime raised.'),
		),
});

const certifiedFor = defineTool({
	name: 'certified_for',
	description: 'Which trades hold a given ticket, and how many of them are on site today.',
	parameters: Type.Object({
		ticket: Type.String({ description: 'e.g. pour supervision, pump operation' }),
	}),
	execute: ({ ticket }) => {
		const word = ticket.toLowerCase().split(' ')[0] ?? '';
		const hits = shiftsState.crew.filter((c) => c.tickets.some((t) => t.includes(word)));
		return log(
			'time-tracker',
			'certified_for',
			{ ticket },
			hits.length === 0
				? `Nobody on this project holds '${ticket}'.`
				: hits
						.map(
							(c) =>
								`${c.trade}: holds ${c.tickets.join(', ')} — ${c.onSiteToday} of ${c.people} on site today`,
						)
						.join('\n'),
		);
	},
});

const requestOvertime = defineTool({
	name: 'request_overtime',
	description: 'Raise an overtime request against a trade. It needs a human to approve it.',
	parameters: Type.Object({
		trade: Type.String(),
		date: Type.String(),
		hours: Type.Number(),
		reason: Type.String(),
	}),
	execute: ({ trade, date, hours, reason }) => {
		shiftsState.overtimeRequests.push({ trade, date, hours, reason, state: 'awaiting approval' });
		return log(
			'time-tracker',
			'request_overtime',
			{ trade, date, hours, reason },
			`Raised: ${trade}, ${date}, +${hours}h — awaiting approval. Reason: ${reason}`,
		);
	},
});

// -- the task list's API -----------------------------------------------------

const taskList = defineTool({
	name: 'task_list',
	description: 'Tasks with owner, due date and status. Filter by status or owner.',
	parameters: Type.Object({
		status: Type.Optional(Type.String()),
		owner: Type.Optional(Type.String()),
	}),
	execute: ({ status, owner }) =>
		log(
			'task-management',
			'task_list',
			{ status, owner },
			tasksState
				.filter((t) => (!status || t.status === status) && (!owner || t.owner === owner))
				.map(
					(t) =>
						`${t.id} ${t.title} — ${t.status}, ${t.owner}, due ${t.due}${t.blockedBy.length ? `, blocked by ${t.blockedBy.join(' + ')}` : ''}${t.note ? ` (${t.note})` : ''}`,
				)
				.join('\n'),
		),
});

const blockingChain = defineTool({
	name: 'blocking_chain',
	description: 'Everything a task waits on, transitively, with the owner of each link.',
	parameters: Type.Object({ id: Type.String() }),
	execute: ({ id }) => {
		const seen = new Set<string>();
		const walk = (tid: string, depth: number): string[] => {
			const t = tasksState.find((x) => x.id === tid);
			if (!t || seen.has(tid)) return [];
			seen.add(tid);
			return [
				`${'  '.repeat(depth)}${t.id} ${t.title} — ${t.status}, ${t.owner}, due ${t.due}${t.note ? ` (${t.note})` : ''}`,
				...t.blockedBy.flatMap((b) => walk(b, depth + 1)),
			];
		};
		return log(
			'task-management',
			'blocking_chain',
			{ id },
			walk(id, 0).join('\n') || `No task ${id}.`,
		);
	},
});

const updateTask = defineTool({
	name: 'update_task',
	description: 'Change a task. Use when a decision on the record changes the plan.',
	parameters: Type.Object({
		id: Type.String(),
		status: Type.Optional(Type.String()),
		due: Type.Optional(Type.String()),
		note: Type.Optional(Type.String()),
	}),
	execute: ({ id, status, due, note }) => {
		const t = tasksState.find((x) => x.id === id);
		if (!t) return log('task-management', 'update_task', { id }, `No task ${id}.`);
		if (status) t.status = status as Task['status'];
		if (due) t.due = due;
		if (note) t.note = note;
		return log(
			'task-management',
			'update_task',
			{ id, status, due, note },
			`${t.id}: ${t.status}, due ${t.due}${t.note ? ` (${t.note})` : ''}`,
		);
	},
});

// -- the materials tracker's API ---------------------------------------------

const stockCheck = defineTool({
	name: 'stock_check',
	description: 'What is on site against what the next pour needs, and what is on order.',
	parameters: Type.Object({}),
	execute: () =>
		log(
			'materials-tracker',
			'stock_check',
			{},
			materialsState.stock
				.map((s) => {
					const short = s.required - s.onSite;
					return (
						`${s.item}: ${s.onSite}${s.unit} on site, needs ${s.required}${s.unit}` +
						(short > 0
							? ` — SHORT ${short.toFixed(1)}${s.unit}, ${s.onOrder}${s.unit} on order`
							: ' — sufficient')
					);
				})
				.join('\n'),
		),
});

const deliveryBoard = defineTool({
	name: 'deliveries',
	description: 'Inbound deliveries with supplier, ETA and whether the slot is firm.',
	parameters: Type.Object({}),
	execute: () =>
		log(
			'materials-tracker',
			'deliveries',
			{},
			materialsState.deliveries
				.map((d) => `${d.ref} ${d.item} ${d.qty} — ${d.supplier}, ETA ${d.eta}, ${d.state}`)
				.join('\n'),
		),
});

const supplierTerms = defineTool({
	name: 'supplier_terms',
	description: 'Lead time and cancellation terms for a supplier.',
	parameters: Type.Object({ supplier: Type.String() }),
	execute: ({ supplier }) => {
		const word = supplier.toLowerCase().split(' ')[0] ?? '';
		const s = materialsState.suppliers.find((x) => x.name.toLowerCase().includes(word));
		return log(
			'materials-tracker',
			'supplier_terms',
			{ supplier },
			s ? `${s.name} — lead ${s.lead}. ${s.terms}` : `No terms held for '${supplier}'.`,
		);
	},
});

const moveDelivery = defineTool({
	name: 'move_delivery',
	description: 'Move a delivery to a new ETA. Use when the plan on the record moves.',
	parameters: Type.Object({
		ref: Type.String(),
		eta: Type.String(),
		reason: Type.Optional(Type.String()),
	}),
	execute: ({ ref, eta, reason }) => {
		const d = materialsState.deliveries.find((x) => x.ref === ref);
		if (!d) return log('materials-tracker', 'move_delivery', { ref }, `No delivery ${ref}.`);
		const was = d.eta;
		d.eta = eta;
		d.state = 'provisional — re-booked';
		return log(
			'materials-tracker',
			'move_delivery',
			{ ref, eta, reason },
			`${d.ref} moved from ${was} to ${eta}${reason ? ` (${reason})` : ''}.`,
		);
	},
});

// -- one agent per product ---------------------------------------------------

const shiftsAgent = defineAgent({
	name: 'time-tracker',
	identity:
		'Time Tracker Agent. Hours logged, who is on site, who holds which ticket, overtime exposure.',
	instructions: `
		You speak for the time tracker and nothing else. Read crew_hours and
		certified_for before any claim about people — never estimate labour from
		memory. Raise overtime with request_overtime when the plan on the record
		needs it; it stays awaiting approval until a human answers, and saying so is
		your job. Speak when a plan needs people who are not there, needs a ticket
		nobody on site holds, or crosses the threshold. Otherwise end your turn.
	`,
	model: MODEL,
	tools: [crewHours, certifiedFor, requestOvertime],
});

const tasksAgent = defineAgent({
	name: 'task-management',
	identity:
		'Task Management Agent. What is open, blocked, who owns it, when it is due, and what waits ' +
		'on what. Watches the door: when somebody opens the workspace it checks what is blocked on them.',
	instructions: `
		You speak for the task list. Read it with task_list or blocking_chain before
		claiming anything about status — the chain is the point, most dates fail
		because of something two links down. When a decision on the record changes
		the plan, write it back with update_task and say which task changed and how.
		Name the owner of a blocking link rather than the room.

		Your seat watches arrivals, so you wake when somebody opens the workspace and
		nobody else does. That is not licence to brief them. Look at what is blocked
		on the person who just arrived; say something only if the list holds an item
		that is theirs and that nobody can move without them, and then say only that
		item. If there is nothing of theirs, end your turn.
	`,
	model: MODEL,
	tools: [taskList, blockingChain, updateTask],
});

const materialsAgent = defineAgent({
	name: 'materials-tracker',
	identity:
		'Materials Tracker Agent. Stock against requirement, inbound deliveries, supplier lead times ' +
		'and terms.',
	instructions: `
		You speak for the materials tracker. Use stock_check, deliveries and
		supplier_terms before any claim about quantities, dates or money — the terms
		are held per supplier and you are the only seat that can read them. Move a
		delivery with move_delivery when the plan on the record moves, and say what
		it saved or cost. Speak when a plan needs material that is not on site, when
		a slot will not support it, or when a change is about to cost money.
	`,
	model: MODEL,
	tools: [stockCheck, deliveryBoard, supplierTerms, moveDelivery],
});

/**
 * The task list is `attentive`, which is `presence` on the attention scale: it
 * wakes when somebody arrives or leaves.
 * The other two sit at the default, so opening the workspace does not wake them —
 * an arrival asks nothing, and three products guessing at what it wants is three
 * briefings nobody requested.
 */
export const AGENTS = [shiftsAgent, attentive(tasksAgent), materialsAgent];

// -- the people, and the aide each of them brings ----------------------------

/**
 * An identity is the public face: what a person owns, and what only they can
 * do. Every product reads it to decide whom to address, and so does the aide.
 *
 * How a person reads is a different fact: what an answer leads with, what to
 * cut, and how much of one they take. That belongs to the person, so it lives
 * in their aide's instructions and nowhere else. Before aides, every product
 * carried a copy of it for every person, and each new person made every
 * product's prompt longer.
 *
 * An aide reads the identity in its context, so nothing here repeats it.
 */
const aide = (person: string, instructions: string) =>
	defineAgent({
		name: `${person}-aide`,
		identity: `${person}'s aide. Holds how they read and writes the one message they read.`,
		model: MODEL,
		instructions: `
			Lead with the decision your person has to make and who holds it. Give them
			the facts that decision turns on — quantities, dates, owners, what is still
			unknown — and cut every other thing the room said, however true.
			Say plainly when the room did not answer what they asked.

			${instructions.trim()}
		`,
	});

export const priya = defineHuman({
	name: 'priya',
	identity:
		'Project manager, site office. Owns the programme and what the client is promised. ' +
		'She is the only one who can book building control and commit a date to the client.',
	aide: aide(
		'priya',
		`
			Open with the date: whether it holds, and if not, the earliest one that
			does. Name only the items she has to clear herself, with their owner and
			their deadline; what somebody else is already handling is not her message.
			She reads cost only when it moves a date, so leave out a price that changes
			nothing. Four sentences at most.
		`,
	),
});

export const sam = defineHuman({
	name: 'sam',
	identity:
		'Site foreman, on the deck with a phone. Owns what the crews actually do tomorrow morning. ' +
		'He can move labour and plant the same day and nobody else can.',
	aide: aide(
		'sam',
		`
			Sam reads standing up. Open with what changes for his crews and when, and
			name the trade, the ticket and the hour. Leave out contract terms,
			cancellation charges and what the client was told: none of it changes what
			he does at seven. Three sentences at most, and no lists longer than the
			crews he has.
		`,
	),
});

export const dan = defineHuman({
	name: 'dan',
	identity:
		'Quantity surveyor. Owns cost, variations and what the client is charged. ' +
		'He owns the hire orders and approves overtime spend.',
	aide: aide(
		'dan',
		`
			Open with the money: what the change costs, what it saves, and which of it
			he has to approve or recover. Give every figure with the supplier and the
			term it comes from, and give no figure the answer does not need. He reads
			sequencing only when it moves money, so state a date only where it changes
			a number. Four sentences at most.
		`,
	),
});

export const PEOPLE: Record<string, HumanDefinition> = { priya, sam, dan };
