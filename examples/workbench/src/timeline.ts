import type { ExchangeView, Message } from '@ambionframework/ambion';
import { formatUsage, type PassView } from './steps.ts';

type ClosedView = Extract<ExchangeView, { status: 'closed' }>;

/**
 * How a message reads in the conversation. A steer is a person's message
 * inside a thread. A returned say is the room giving an agent's say back to it.
 */
export type Role = 'question' | 'said' | 'summary' | 'steer' | 'returned';

export interface MessageBlock {
	type: 'message';
	message: Message;
	role: Role;
	/** Set on a scheduled say that its seat or the host dismissed. It does not return. */
	dismissed?: true;
}

/** The thread between a question and its summary. It opens and closes. */
export interface DiscussionBlock {
	type: 'discussion';
	/** The seq of the exchange's question. It names the discussion across reads. */
	key: string;
	count: number;
	voices: string[];
	/** Why the exchange has no published summary, or an empty string when it has one. */
	flag: string;
	/** What the exchange spent, or an empty string when the record holds no usage. */
	cost: string;
	/** How many activations the exchange ran, for the steps view. */
	activations: number;
	expanded: boolean;
	items: MessageBlock[];
}

interface NoteBlock {
	type: 'note';
	text: string;
}

/** The trace of one activation, as `/steps` shows it. */
export interface StepsBlock {
	type: 'steps';
	title: string;
	/** True while the activation has no end step. */
	running: boolean;
	passes: PassView[];
}

/** The open exchange, at the end of the conversation. */
export interface LiveBlock {
	type: 'live';
	text: string;
	/** The latest work an agent reported, when there is one. */
	detail?: string;
}

export type Block = MessageBlock | DiscussionBlock | NoteBlock | StepsBlock | LiveBlock;

export interface TimelineInput {
	messages: readonly Message[];
	exchanges: readonly ExchangeView[];
	open?: { owner: string };
	/** The latest work an agent reported in the open exchange. */
	activity?: string;
	humans: ReadonlySet<string>;
	/** The agents that are working now. */
	working: readonly string[];
	/** The keys of the discussions the person opened. */
	expanded: ReadonlySet<string>;
	/** Blocks that follow the closed exchanges, before the live block. */
	tail?: readonly Block[];
}

interface Group {
	exchange: ClosedView;
	source: Message[];
	summary: Message | undefined;
	direct: boolean;
}

const spoken = (message: Message): boolean =>
	message.kind === 'said' || message.kind === 'summary' || message.kind === 'returned';

function waitingOn(exchange: ClosedView): string | undefined {
	return exchange.outcome.kind === 'awaiting' ? `Waiting on ${exchange.outcome.person}` : undefined;
}

function flagFor(exchange: ClosedView): string {
	const waiting = waitingOn(exchange);
	if (waiting) return waiting;
	const status = exchange.summary.status;
	if (status === 'published') return '';
	if (status === 'pending') return 'Summary pending';
	if (status === 'failed') return 'Summary failed';
	return 'No summary';
}

function noteFor(exchange: ClosedView): string {
	const cost = formatUsage(exchange.usage);
	const suffix = cost ? ` · ${cost}` : '';
	const waiting = waitingOn(exchange);
	if (waiting) return `${waiting}${suffix}`;
	const status = exchange.summary.status;
	if (status === 'pending') return `Closed, summary pending${suffix}`;
	if (status === 'failed') return `Closed, summary failed${suffix}`;
	return `Closed without a summary${suffix}`;
}

function groupsOf(input: TimelineInput): Group[] {
	return input.exchanges
		.filter((exchange): exchange is ClosedView => exchange.status === 'closed')
		.map((exchange) => {
			const source = input.messages.filter(
				(message) =>
					(message.kind === 'said' || message.kind === 'returned') &&
					message.seq > exchange.from &&
					message.seq <= exchange.through,
			);
			const published = exchange.summary.status === 'published';
			return {
				exchange,
				source,
				summary: published ? exchange.summary.summary : undefined,
				// One agent reply shows directly. A lone person's message is not a reply, so an
				// exchange that holds only that, such as an aborted one, keeps its closing mark.
				direct: source.length === 1 && !input.humans.has(source[0]?.from ?? ''),
			};
		});
}

/** Where each message and summary of the closed exchanges belongs. */
interface Index {
	bySource: Map<number, Group>;
	byOpening: Map<number, Group>;
	summarySeqs: Set<number>;
	directSeqs: Set<number>;
}

function indexGroups(groups: readonly Group[]): Index {
	const index: Index = {
		bySource: new Map(),
		byOpening: new Map(),
		summarySeqs: new Set(),
		directSeqs: new Set(),
	};
	for (const group of groups) {
		index.byOpening.set(group.exchange.from, group);
		if (group.summary) index.summarySeqs.add(group.summary.seq);
		for (const message of group.source) {
			index.bySource.set(message.seq, group);
			if (group.direct) index.directSeqs.add(message.seq);
		}
	}
	return index;
}

class Builder {
	private readonly input: TimelineInput;
	private readonly groups: Group[];
	private readonly index: Index;
	private readonly blocks: Block[] = [];
	private readonly done = new Set<Group>();
	/** The seqs of the scheduled says that a dismissal names. */
	private readonly dismissed: ReadonlySet<number>;

	constructor(input: TimelineInput) {
		this.input = input;
		this.groups = groupsOf(input);
		this.index = indexGroups(this.groups);
		this.dismissed = new Set(
			input.messages.flatMap((message) => (message.kind === 'dismissed' ? [message.message] : [])),
		);
	}

	build(): Block[] {
		for (const message of this.input.messages.filter(spoken)) this.place(message);
		for (const group of this.groups) this.emit(group);
		this.blocks.push(...(this.input.tail ?? []));
		if (this.input.open)
			this.blocks.push(liveBlock(this.input.open.owner, this.input.working, this.input.activity));
		return this.blocks;
	}

	private roleOf = (message: Message, inThread: boolean): Role => {
		if (message.kind === 'summary') return 'summary';
		if (message.kind === 'returned') return 'returned';
		if (!this.input.humans.has(message.from ?? '')) return 'said';
		return inThread ? 'steer' : 'question';
	};

	private blockOf = (message: Message, inThread: boolean): MessageBlock => ({
		type: 'message',
		message,
		role: this.roleOf(message, inThread),
		...(this.dismissed.has(message.seq) ? { dismissed: true } : {}),
	});

	/** Put one message in its place: in a thread, in the open, or nowhere when a summary shows it. */
	private place(message: Message): void {
		const grouped = this.index.bySource.get(message.seq);
		if (grouped && !this.index.directSeqs.has(message.seq)) {
			this.emit(grouped);
			return;
		}
		if (this.index.summarySeqs.has(message.seq)) return;
		this.blocks.push(this.blockOf(message, false));
		const opening = this.index.byOpening.get(message.seq);
		if (opening) this.emit(opening);
	}

	private emit(group: Group): void {
		if (this.done.has(group)) return;
		this.done.add(group);
		if (!group.direct) this.blocks.push(...groupBlocks(group, this.input, this.blockOf));
	}
}

/**
 * Turn the record into the blocks the conversation shows.
 *
 * A closed exchange shows its question, then one discussion holding every spoken
 * message after it, in order, and then its summary. A person's steering message
 * is part of the discussion. An exchange with one reply shows that reply and no
 * discussion or summary. The open exchange keeps its messages in the open, and a
 * live block follows them.
 */
export function buildTimeline(input: TimelineInput): Block[] {
	return new Builder(input).build();
}

function groupBlocks(
	group: Group,
	input: TimelineInput,
	blockOf: (message: Message, inThread: boolean) => MessageBlock,
): Block[] {
	const summary: Block[] = group.summary
		? [{ type: 'message', message: group.summary, role: 'summary' }]
		: [];
	if (group.source.length === 0)
		return summary.length > 0 ? summary : [{ type: 'note', text: noteFor(group.exchange) }];
	const key = String(group.exchange.from);
	const voices = [...new Set(group.source.map((message) => message.from ?? ''))].filter(Boolean);
	const discussion: DiscussionBlock = {
		type: 'discussion',
		key,
		count: group.source.length,
		voices,
		flag: flagFor(group.exchange),
		cost: formatUsage(group.exchange.usage),
		activations: group.exchange.activations.length,
		expanded: input.expanded.has(key),
		items: group.source.map((message) => blockOf(message, true)),
	};
	return [discussion, ...summary];
}

function liveBlock(owner: string, working: readonly string[], activity?: string): LiveBlock {
	const agents = working.length > 0 ? ` with ${working.join(', ')}` : '';
	return { type: 'live', text: `Working on ${owner}’s question${agents}`, detail: activity };
}

/** The keys of the discussions in the blocks, top to bottom. */
export function discussionKeys(blocks: readonly Block[]): string[] {
	return blocks.flatMap((block) => (block.type === 'discussion' ? [block.key] : []));
}
