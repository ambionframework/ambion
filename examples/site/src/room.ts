/**
 * Kestrel Yard, Block C — a construction management suite where each product
 * is an agent.
 *
 * Three products hold their own state and their own API and know nothing of
 * each other's internals: they ask on the record, the way a person does. Two
 * specialists are on call in the reserve, and the room's assistant seats one
 * when a question turns on what that specialist alone holds. Three people
 * share the room from a site office, a phone on the deck and a cost desk,
 * and the assistant writes each of them the one message they read, the way
 * they read.
 *
 * Every product and specialist shares one workspace: the site drive, an
 * in-memory filesystem holding the documents the site works to. Each reads
 * the documents its claims rest on, and appends to the site diary when it
 * changes its own state.
 *
 * `main.ts` opens this interactively. `demo.ts` drives one scripted run of it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	attentive,
	defineAgent,
	defineHuman,
	defineTool,
	defineWorkspace,
	type HumanDefinition,
	memoryBackend,
	type SeedWriter,
} from '@ambionframework/ambion';
import { Type } from 'typebox';

export const MODEL = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
export const ROOM_NAME = 'kestrel-yard-block-c';

export const GOAL = `
	Deliver Block C at Kestrel Yard on programme and to spec. The Level 3 slab
	pour is the next milestone and it is currently blocked. Keep the task list,
	the materials position and the labour plan consistent with what the site
	actually decides. The site drive holds the documents the site works to:
	the pour plan, the forecast, building control's rules and the site diary.
	On site, today is Tue 25 Aug, and every date the products, the drive and
	the record hold is on the site's calendar. The clock at the top of your
	context is the room's own and says nothing about the site: never compare
	a site date with it, never call a product's data, a forecast or a delivery
	stale because of it, and never tell a person what today's date is. Tue 25
	Aug is today.
`;

// -- the site drive ----------------------------------------------------------

/** The documents checked in beside this file: what every run starts from. */
const DRIVE_SEED = fileURLToPath(new URL('../drive', import.meta.url));

/** The scenario's date, which is the diary file every product appends to. */
export const TODAY = '2026-08-25';

/** Every checked-in document: read one off disk, write it into the drive, move on. */
async function seedDrive(write: SeedWriter): Promise<void> {
	const entries = readdirSync(DRIVE_SEED, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const full = join(entry.parentPath, entry.name);
		await write.writeFile(`/${full.slice(DRIVE_SEED.length + 1)}`, readFileSync(full, 'utf8'));
	}
}

const driveBackend = memoryBackend({ seed: seedDrive });

/**
 * The workspace the products connect to. An in-memory filesystem backs it,
 * seeded from `drive/` above; every product gets a home in it, and the four
 * built-in tools reach it.
 */
export const SITE_DRIVE = defineWorkspace({
	name: 'kestrel-yard-drive',
	backend: driveBackend,
});

/** Every document on the drive, as a host reads it: path under `site/`, and text. */
export async function driveFiles(): Promise<{ path: string; text: string }[]> {
	const files = await driveBackend.readFiles();
	return files
		.filter((file) => file.path.startsWith('/site/'))
		.map((file) => ({ path: file.path.slice(1), text: file.text }));
}

/**
 * What every product is told about the drive. The documents are named once,
 * here, and each product adds the one it has to read before it speaks.
 */
const DRIVE_BRIEF = `
	The site drive is your workspace, and /site/README.md indexes it: the pour
	plan at /site/pour-plan/level-3-slab.md, the week's forecast at
	/site/weather/week-35.md, building control's booking rules at
	/site/inspections/building-control.md, and the site diary at
	/site/diary/<date>.md, one file per day. Read a document before you claim
	what it says, and name the figure and the file when you do. When you change
	your own product's state, append one line to today's diary,
	/site/diary/${TODAY}.md, with bash:
	echo "- HH:MM <your name> — what changed, and why" >> /site/diary/${TODAY}.md
	Append, and never rewrite a diary file: a colleague may be writing to it too.
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
		note: 'Inspector slot not booked. How a slot is booked: /site/inspections/building-control.md',
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
		note: 'Hire H-207 is provisional on the plant desk; the pour day decides which day to confirm.',
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

/** What building control can offer, and what the site has asked of it. */
export const inspectionsState = {
	noticeHours: 48,
	/** Slots the duty inspector can still take, and when each stops being bookable. */
	slots: [
		{ slot: 'Thu 27 Aug, 13:00', bookBy: 'Tue 25 Aug, 13:00', state: 'open' },
		{ slot: 'Fri 28 Aug, 08:00', bookBy: 'Wed 26 Aug, 08:00', state: 'open' },
		{ slot: 'Fri 28 Aug, 13:00', bookBy: 'Wed 26 Aug, 13:00', state: 'open' },
		{ slot: 'Mon 31 Aug, 08:00', bookBy: 'Thu 27 Aug, 08:00', state: 'open' },
	],
	requests: [] as { slot: string; inspection: string; requestedBy: string; state: string }[],
};

/** The plant desk's board: what is hired, for when, and on what terms. */
export const plantState = {
	hires: [
		{
			ref: 'H-207',
			plant: 'Concrete pump, 36 m boom',
			supplier: 'Rapid Pumps',
			onSite: 'Wed 26 Aug, evening',
			forDay: 'Thu 27 Aug',
			state: 'provisional — T-130 not confirmed',
		},
	],
	suppliers: [
		{
			name: 'Rapid Pumps',
			terms:
				'A booked day moves free with 24h notice. Inside 24h a re-mobilisation charge of £350 applies. Saturday delivery carries a £200 weekend uplift. The operator is the site’s own; the hire is the pump alone.',
		},
	],
};

/** The temporary works coordinator's diary: the checks the pour plan requires before concrete goes in. */
export const temporaryWorksState = {
	coordinator: 'R. Okafor',
	checks: [
		{
			ref: 'TW-31',
			what: 'Level 3 formwork and falsework, pre-pour check',
			state: 'not booked — formwork closed to 80%, striking crew on the falsework',
			needs:
				'Formwork closed and propped. Booked the working day before the pour; done 06:30 on the morning of it.',
		},
	],
	bookings: [] as { ref: string; morning: string; requestedBy: string }[],
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

// -- the building control liaison's API --------------------------------------

const inspectionSlots = defineTool({
	name: 'inspection_slots',
	description:
		'Which inspection slots building control can still take, and the deadline to book each one.',
	parameters: Type.Object({}),
	execute: () =>
		log(
			'building-control',
			'inspection_slots',
			{},
			`Notice is ${inspectionsState.noticeHours} working hours; slots are 08:00 and 13:00, Monday to Friday.\n` +
				inspectionsState.slots
					.map((s) => `${s.slot} — ${s.state}, book by ${s.bookBy}`)
					.join('\n') +
				(inspectionsState.requests.length
					? `\nRequested: ${inspectionsState.requests.map((r) => `${r.inspection} at ${r.slot} (${r.state})`).join('; ')}`
					: '\nNothing requested this week.'),
		),
});

const requestInspection = defineTool({
	name: 'request_inspection',
	description:
		'Ask for an inspection slot. Only the project manager can confirm a booking with building control; this records the request against the slot.',
	parameters: Type.Object({
		slot: Type.String({ description: 'A slot as inspection_slots lists it.' }),
		inspection: Type.String({ description: 'e.g. Level 3 pre-pour' }),
		requestedBy: Type.String(),
	}),
	execute: ({ slot, inspection, requestedBy }) => {
		const found = inspectionsState.slots.find((s) => s.slot === slot);
		if (!found) {
			return log('building-control', 'request_inspection', { slot }, `No slot '${slot}'.`);
		}
		found.state = 'requested';
		inspectionsState.requests.push({
			slot,
			inspection,
			requestedBy,
			state: 'awaiting the project manager’s confirmation',
		});
		return log(
			'building-control',
			'request_inspection',
			{ slot, inspection, requestedBy },
			`Requested: ${inspection} at ${slot}, by ${requestedBy}. The project manager confirms it with building control before ${found.bookBy}.`,
		);
	},
});

// -- the plant desk's API ----------------------------------------------------

const hireBoard = defineTool({
	name: 'hire_board',
	description:
		'Plant on hire or booked: what, from whom, on site when, for which day, and whether it is confirmed.',
	parameters: Type.Object({}),
	execute: () =>
		log(
			'plant-hire',
			'hire_board',
			{},
			plantState.hires
				.map(
					(h) =>
						`${h.ref} ${h.plant} — ${h.supplier}, on site ${h.onSite}, for ${h.forDay}, ${h.state}`,
				)
				.join('\n'),
		),
});

const hireTerms = defineTool({
	name: 'hire_terms',
	description: 'What moving or cancelling a hire costs, per supplier.',
	parameters: Type.Object({ supplier: Type.String() }),
	execute: ({ supplier }) => {
		const word = supplier.toLowerCase().split(' ')[0] ?? '';
		const s = plantState.suppliers.find((x) => x.name.toLowerCase().includes(word));
		return log(
			'plant-hire',
			'hire_terms',
			{ supplier },
			s ? `${s.name} — ${s.terms}` : `No terms held for '${supplier}'.`,
		);
	},
});

const moveHire = defineTool({
	name: 'move_hire',
	description: 'Move a hire to a new day. Use when the pour date on the record moves.',
	parameters: Type.Object({
		ref: Type.String(),
		onSite: Type.String(),
		forDay: Type.String(),
		reason: Type.Optional(Type.String()),
	}),
	execute: ({ ref, onSite, forDay, reason }) => {
		const h = plantState.hires.find((x) => x.ref === ref);
		if (!h) return log('plant-hire', 'move_hire', { ref }, `No hire ${ref}.`);
		const was = h.forDay;
		h.onSite = onSite;
		h.forDay = forDay;
		h.state = 'provisional — re-booked, T-130 not confirmed';
		return log(
			'plant-hire',
			'move_hire',
			{ ref, onSite, forDay, reason },
			`${h.ref} moved from ${was} to ${forDay}, on site ${onSite}${reason ? ` (${reason})` : ''}.`,
		);
	},
});

// -- the temporary works coordinator's API -----------------------------------

const checkStatus = defineTool({
	name: 'check_status',
	description:
		'The temporary works checks a pour needs, what each one requires, and whether it is booked.',
	parameters: Type.Object({}),
	execute: () =>
		log(
			'temporary-works',
			'check_status',
			{},
			`Coordinator ${temporaryWorksState.coordinator}.\n` +
				temporaryWorksState.checks
					.map((c) => `${c.ref} ${c.what} — ${c.state}. Needs: ${c.needs}`)
					.join('\n') +
				(temporaryWorksState.bookings.length
					? `\nBooked: ${temporaryWorksState.bookings.map((b) => `${b.ref} for ${b.morning} (by ${b.requestedBy})`).join('; ')}`
					: ''),
		),
});

const bookCheck = defineTool({
	name: 'book_check',
	description: 'Book the coordinator for a pre-pour check on the morning of a pour day.',
	parameters: Type.Object({
		ref: Type.String(),
		morning: Type.String({ description: 'The pour day, e.g. Fri 28 Aug' }),
		requestedBy: Type.String(),
	}),
	execute: ({ ref, morning, requestedBy }) => {
		const c = temporaryWorksState.checks.find((x) => x.ref === ref);
		if (!c) return log('temporary-works', 'book_check', { ref }, `No check ${ref}.`);
		c.state = `booked for ${morning}, 06:30`;
		temporaryWorksState.bookings.push({ ref, morning, requestedBy });
		return log(
			'temporary-works',
			'book_check',
			{ ref, morning, requestedBy },
			`${ref} booked: ${temporaryWorksState.coordinator} on site ${morning} at 06:30, requested by ${requestedBy}.`,
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

		${DRIVE_BRIEF.trim()}
		Before you say a crew is enough for a pour, read the pour plan: it says who
		a pour needs on the deck, how many, and which ticket each of them holds.
		Before you say a day holds, read the forecast against the plan's limits.
	`,
	model: MODEL,
	tools: [crewHours, certifiedFor, requestOvertime],
	workspace: SITE_DRIVE,
});

const tasksAgent = defineAgent({
	name: 'task-management',
	identity:
		'Task Management Agent. What is open, blocked, who owns it, when it is due, and what waits ' +
		'on what. Watches the door: when somebody opens the room it checks what is blocked on them.',
	instructions: `
		You speak for the task list. Read it with task_list or blocking_chain before
		claiming anything about status — the chain is the point, most dates fail
		because of something two links down. When a decision on the record changes
		the plan, write it back with update_task and say which task changed and how.
		Name the owner of a blocking link rather than the room.

		Your seat watches arrivals, so you wake when somebody opens the room and
		nobody else does. That is not licence to brief them. Look at what is blocked
		on the person who just arrived; say something only if the list holds an item
		that is theirs and that nobody can move without them, and then say only that
		item. If there is nothing of theirs, end your turn.

		${DRIVE_BRIEF.trim()}
		Before you give a date for T-121, read building control's rules: they
		decide which days an inspection can happen, and a pour date is only as
		good as the inspection before it. The pour plan lists what has to be done
		before a pour, in order.
	`,
	model: MODEL,
	tools: [taskList, blockingChain, updateTask],
	workspace: SITE_DRIVE,
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

		${DRIVE_BRIEF.trim()}
		Before you move a delivery or name a pour day, read the forecast: it
		decides whether a slot holds. The pour plan holds the quantity, the pump
		and when the order locks.
	`,
	model: MODEL,
	tools: [stockCheck, deliveryBoard, supplierTerms, moveDelivery],
	workspace: SITE_DRIVE,
});

/**
 * The task list is `attentive`, which is `presence` on the attention scale: it
 * wakes when somebody arrives or leaves.
 * The other two sit at the default, so opening the room does not wake them —
 * an arrival asks nothing, and three products guessing at what it wants is three
 * briefings nobody requested.
 */
export const AGENTS = [shiftsAgent, attentive(tasksAgent), materialsAgent];

// -- the specialists on call ---------------------------------------------------

/**
 * Two seats the site does not run all day. They wait in the reserve, and the
 * assistant seats one when a question turns on what it alone holds. An
 * identity here says what the specialist holds and when it is worth a seat,
 * because the identity is the whole of what the assistant reads to decide.
 */
const inspectionsAgent = defineAgent({
	name: 'building-control',
	identity:
		'Building Control Liaison Agent. Which inspection slots the duty inspector can take, the ' +
		'deadline to book each one, and what the inspector has to see. Worth a seat when a pour ' +
		'date turns on an inspection being booked.',
	instructions: `
		You speak for the building control liaison and nothing else. Read
		inspection_slots before any claim about a slot or a deadline. When the room
		settles on a pour day, request the slot that day needs with
		request_inspection, in the name of whoever decided, and say plainly that
		only the project manager can confirm it with building control. Speak when a
		date on the record needs a slot nobody has booked, or names a slot that
		cannot be booked in time. Otherwise end your turn.

		${DRIVE_BRIEF.trim()}
		Building control's own rules are at /site/inspections/building-control.md:
		read them before you say when an inspection can happen, and the pour plan
		before you say what the inspector needs to see.
	`,
	model: MODEL,
	tools: [inspectionSlots, requestInspection],
	workspace: SITE_DRIVE,
});

const plantAgent = defineAgent({
	name: 'plant-hire',
	identity:
		'Plant Hire Agent. The pump and any other hired plant: on site when, for which day, ' +
		'confirmed or not, and what moving a hire costs. Worth a seat when a pour day moves or a ' +
		'plan needs plant that is not booked.',
	instructions: `
		You speak for the plant desk and nothing else. Read hire_board and
		hire_terms before any claim about plant, dates or money. Move a hire with
		move_hire when the pour date on the record moves, and say what it cost or
		saved and who has to confirm it. Speak when a plan needs plant that is not
		booked for that day, or when a move is about to cost money. Otherwise end
		your turn.

		${DRIVE_BRIEF.trim()}
		The pour plan says which plant a pour needs and when it has to be on site:
		read it before you say a hire covers a day.
	`,
	model: MODEL,
	tools: [hireBoard, hireTerms, moveHire],
	workspace: SITE_DRIVE,
});

const temporaryWorksAgent = defineAgent({
	name: 'temporary-works',
	identity:
		'Temporary Works Coordinator Agent. The formwork and falsework check the pour plan requires ' +
		'on the morning of a pour, what it needs, and whether it is booked. Worth a seat once a pour ' +
		'day is fixed and the check has to be booked; not before.',
	instructions: `
		You speak for the temporary works coordinator and nothing else. Read
		check_status before any claim about a check. Book the check with book_check
		once a pour day stands on the record, in the name of whoever fixed it, and
		say what the formwork crew must have done by then. Speak when a pour day on
		the record has no check booked, or when the formwork will not be closed in
		time. Otherwise end your turn.

		${DRIVE_BRIEF.trim()}
		The pour plan lists the check among what has to be done before a pour, and
		the diary says how far the formwork has got: read both before you speak.
	`,
	model: MODEL,
	tools: [checkStatus, bookCheck],
	workspace: SITE_DRIVE,
});

/** The reserve. Nothing wakes these seats until the assistant seats one. */
export const AVAILABLE = [inspectionsAgent, plantAgent, temporaryWorksAgent];

// -- the people, and the assistant that writes for them -----------------------

/**
 * An identity is the public face: what a person owns, and what only they can
 * do. Every product reads it to decide whom to address, and so does the
 * assistant.
 *
 * How a person reads is a different fact: what an answer leads with, what to
 * cut, and how much of one they take. That belongs to the person, so it lives
 * in their `preferences` and nowhere else. The assistant reads it when it
 * writes for them, and no product reads it. Before that, every product
 * carried a copy of it for every person, and each new person made every
 * product's prompt longer.
 */
export const priya = defineHuman({
	name: 'priya',
	identity:
		'Project manager, site office. Owns the programme and what the client is promised. ' +
		'She is the only one who can book building control and commit a date to the client.',
	preferences: `
		Open with the date: whether it holds, and if not, the earliest one that
		does. Name only the items she has to clear herself, with their owner and
		their deadline; what somebody else is already handling is not her message.
		She reads cost only when it moves a date, so leave out a price that changes
		nothing. Four sentences at most.
	`,
});

export const sam = defineHuman({
	name: 'sam',
	identity:
		'Site foreman, on the deck with a phone. Owns what the crews actually do tomorrow morning. ' +
		'He can move labour and plant the same day and nobody else can.',
	preferences: `
		Sam reads standing up. Open with what changes for his crews and when, and
		name the trade, the ticket and the hour. Leave out contract terms,
		cancellation charges and what the client was told: none of it changes what
		he does at seven. Three sentences at most, and no lists longer than the
		crews he has.
	`,
});

export const dan = defineHuman({
	name: 'dan',
	identity:
		'Quantity surveyor. Owns cost, variations and what the client is charged. ' +
		'He owns the hire orders and approves overtime spend.',
	preferences: `
		Open with the money: what the change costs, what it saves, and which of it
		he has to approve or recover. Give every figure with the supplier and the
		term it comes from, and give no figure the answer does not need. He reads
		sequencing only when it moves money, so state a date only where it changes
		a number. Four sentences at most.
	`,
});

/**
 * The room's one assistant. It composes the room when a question opens, from
 * the specialists on call, and it writes for whoever asked when the room goes
 * quiet, with that person's preferences beside the record. What is here is
 * the judgment both activations share; what differs by person is on the
 * person.
 */
export const ASSISTANT = defineAgent({
	name: 'assistant',
	identity:
		'Seats a specialist from the reserve when a question needs one, and writes the one ' +
		'message a person reads when their exchange closes.',
	model: MODEL,
	instructions: `
		When a question opens, the three products already in the room cover tasks,
		labour and materials, and they read the drive. Seat a specialist only when
		the answer turns on something that specialist alone holds: an inspection
		slot and its deadline, a hire and what moving it costs, a check that has to
		be booked. A question the products can answer from their own data and the
		drive needs nobody seated, and leaving the roster as it stands is the usual
		answer. A specialist already in the room needs no seating.

		When the room is quiet, lead with the decision your person has to make and
		who holds it. Give them the facts that decision turns on — quantities,
		dates, owners, what is still unknown — and cut every other thing the room
		said, however true. Say plainly when the room did not answer what they asked.
	`,
});

export const PEOPLE: Record<string, HumanDefinition> = { priya, sam, dan };
