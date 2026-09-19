import type { ExchangeView, Message } from '@ambionframework/ambion';

type ClosedView = Extract<ExchangeView, { status: 'closed' }>;

/** How a message reads in the conversation. A steer is a person's message inside a thread. */
export type Role = 'question' | 'said' | 'summary' | 'steer';

export interface MessageBlock {
	type: 'message';
	message: Message;
	role: Role;
}

/** The thread between a question and its summary. It opens and closes. */
export interface DiscussionBlock {
	type: 'discussion';
	/** The seq of the exchange's question. It names the discussion across polls. */
	key: string;
	count: number;
	voices: string[];
	/** Why the exchange has no published summary, or an empty string when it has one. */
	flag: string;
	expanded: boolean;
	items: MessageBlock[];
}

interface NoteBlock {
	type: 'note';
	text: string;
}

/** The open exchange, at the end of the conversation. */
export interface LiveBlock {
	type: 'live';
	text: string;
	/** The latest work an agent reported, when there is one. */
	detail?: string;
}

export type Block = MessageBlock | DiscussionBlock | NoteBlock | LiveBlock;

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
}

interface Group {
	exchange: ClosedView;
	source: Message[];
	summary: Message | undefined;
	direct: boolean;
}

const spoken = (message: Message): boolean => message.kind === 'said' || message.kind === 'summary';

function flagFor(outcome: string | undefined): string {
	if (outcome === 'published') return '';
	if (outcome === 'pending') return 'Summary pending';
	if (outcome === 'failed') return 'Summary failed';
	return 'No summary';
}

function noteFor(outcome: string | undefined): string {
	if (outcome === 'pending') return 'Closed, summary pending';
	if (outcome === 'failed') return 'Closed, summary failed';
	return 'Closed without a summary';
}

function groupsOf(input: TimelineInput): Group[] {
	return input.exchanges
		.filter((exchange): exchange is ClosedView => exchange.status === 'closed')
		.map((exchange) => {
			const source = input.messages.filter(
				(message) =>
					message.kind === 'said' && message.seq > exchange.from && message.seq <= exchange.through,
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

	constructor(input: TimelineInput) {
		this.input = input;
		this.groups = groupsOf(input);
		this.index = indexGroups(this.groups);
	}

	build(): Block[] {
		for (const message of this.input.messages.filter(spoken)) this.place(message);
		for (const group of this.groups) this.emit(group);
		if (this.input.open)
			this.blocks.push(liveBlock(this.input.open.owner, this.input.working, this.input.activity));
		return this.blocks;
	}

	private roleOf = (message: Message, inThread: boolean): Role => {
		if (message.kind === 'summary') return 'summary';
		if (!this.input.humans.has(message.from ?? '')) return 'said';
		return inThread ? 'steer' : 'question';
	};

	/** Put one message in its place: in a thread, in the open, or nowhere when a summary shows it. */
	private place(message: Message): void {
		const grouped = this.index.bySource.get(message.seq);
		if (grouped && !this.index.directSeqs.has(message.seq)) {
			this.emit(grouped);
			return;
		}
		if (this.index.summarySeqs.has(message.seq)) return;
		this.blocks.push({ type: 'message', message, role: this.roleOf(message, false) });
		const opening = this.index.byOpening.get(message.seq);
		if (opening) this.emit(opening);
	}

	private emit(group: Group): void {
		if (this.done.has(group)) return;
		this.done.add(group);
		if (!group.direct) this.blocks.push(...groupBlocks(group, this.input, this.roleOf));
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
	roleOf: (message: Message, inThread: boolean) => Role,
): Block[] {
	const outcome = group.exchange.summary.status;
	const summary: Block[] = group.summary
		? [{ type: 'message', message: group.summary, role: 'summary' }]
		: [];
	if (group.source.length === 0)
		return summary.length > 0 ? summary : [{ type: 'note', text: noteFor(outcome) }];
	const key = String(group.exchange.from);
	const voices = [...new Set(group.source.map((message) => message.from ?? ''))].filter(Boolean);
	const discussion: DiscussionBlock = {
		type: 'discussion',
		key,
		count: group.source.length,
		voices,
		flag: flagFor(outcome),
		expanded: input.expanded.has(key),
		items: group.source.map((message) => ({
			type: 'message',
			message,
			role: roleOf(message, true),
		})),
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
