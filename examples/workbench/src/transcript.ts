import type { Message } from '@ambionframework/ambion';
import {
	BoxRenderable,
	bg,
	bold,
	type CliRenderer,
	fg,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import { tui as palette } from './brand.ts';
import { chipLine, type RefItem } from './refs.ts';
import type {
	Block,
	DiscussionBlock,
	LiveBlock,
	MessageBlock,
	Role,
	StepsBlock,
} from './timeline.ts';

/** The cells a chip loses to the padding, the rail, and the scrollbar. */
const CHIP_MARGIN = 8;
const CHIP_MIN = 20;

/** What the transcript marks besides the selected discussion: refs, the chosen ref, a focused message. */
export interface Marks {
	/** The refs of the shown messages, by the seq of the message. */
	refs: ReadonlyMap<number, readonly RefItem[]>;
	/** The id of the chosen ref. */
	picked?: string;
	/** The seq of the message a ref jumped to. */
	focus?: number;
}

/** Wait one layout pass, so a scroll position can use the new heights. */
const SETTLE_MS = 40;

type Chunk = ReturnType<typeof fg> extends (input: never) => infer Out ? Out : never;

interface Paint {
	color?: string;
	fill?: string;
	strong?: boolean;
}

/** One styled run of text. */
function paint(text: string, { color = palette.text, fill, strong }: Paint = {}): Chunk {
	let chunk = fg(color)(text);
	if (fill) chunk = bg(fill)(chunk);
	return strong ? bold(chunk) : chunk;
}

/** A label after the row title, or an empty run when the label is empty. */
const tag = (text: string, color: string, fill: string): Chunk =>
	paint(text ? `  ${text}` : '', { color, fill });

const clock = (at: string | undefined): string => {
	const date = at ? new Date(at) : undefined;
	if (!date || Number.isNaN(date.valueOf())) return '';
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

function bodyOf(message: Message): string {
	if (message.kind === 'said' || message.kind === 'summary' || message.kind === 'returned')
		return message.text ?? '';
	return '';
}

/** When a say to oneself returns, as a clock time after its header, or that it was dismissed. */
function returnsAt({ message, dismissed }: MessageBlock): string {
	if (message.kind !== 'said' || message.after === undefined) return '';
	if (dismissed) return '  dismissed';
	return `  returns ${clock(new Date(Date.parse(message.at) + message.after * 1000).toISOString())}`;
}

function headerOf(block: MessageBlock, fill?: string): Chunk[] {
	const { message, role } = block;
	const from = message.kind === 'said' || message.kind === 'summary' ? (message.from ?? '') : '';
	const to = message.kind === 'said' || message.kind === 'summary' ? message.to : undefined;
	const at = paint(`  ${clock(message.at)}`, { color: palette.dim, fill });
	if (role === 'question') return [paint(from, { strong: true, fill }), at];
	if (message.kind === 'returned')
		return [
			paint('returned', { color: palette.green, strong: true, fill }),
			paint(` → ${message.to}`, { color: palette.muted, fill }),
			paint(` for ${message.owner}`, { color: palette.muted, fill }),
			at,
		];
	const arrow = to ? paint(` → ${to}`, { color: palette.muted, fill }) : paint('', { fill });
	if (role === 'summary')
		return [
			paint('summary', { color: palette.summary, strong: true, fill }),
			paint(` ${from}`, { color: palette.muted, fill }),
			arrow,
			at,
		];
	if (role === 'steer')
		return [
			paint('steer', { color: palette.accent, strong: true, fill }),
			paint(` ${from}`, { fill }),
			arrow,
			at,
		];
	const returns = paint(returnsAt(block), { color: palette.accent, fill });
	return [paint(from, { color: palette.accent, fill }), arrow, returns, at];
}

const railOf: Record<Role, string> = {
	question: palette.text,
	said: palette.line,
	summary: palette.summary,
	steer: palette.accent,
	returned: palette.green,
};

/** The conversation: the blocks of a room, with each discussion open or closed. */
export class Transcript {
	readonly root: ScrollBoxRenderable;
	private readonly renderer: CliRenderer;
	private readonly list: BoxRenderable;

	constructor(renderer: CliRenderer) {
		this.renderer = renderer;
		this.root = new ScrollBoxRenderable(renderer, {
			flexGrow: 1,
			stickyScroll: true,
			stickyStart: 'bottom',
			scrollY: true,
			backgroundColor: palette.bg,
			scrollbarOptions: {
				trackOptions: { backgroundColor: palette.panel, foregroundColor: palette.line },
			},
		});
		this.list = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '100%',
			paddingRight: 2,
			gap: 1,
			backgroundColor: palette.bg,
		});
		this.root.add(this.list);
	}

	/**
	 * Draw the blocks again. The selected discussion, if any, shows a highlight.
	 * Drawing again resets the scroll position, so the transcript puts it back once
	 * the layout is known: at the bottom when it was there, at the same line when it
	 * was not, or at the node the caller asks to reveal, by its id. The caller can
	 * also ask for the bottom, as after a notice or a message that the person sent.
	 */
	render(
		blocks: readonly Block[],
		selected: string | undefined,
		notice: string | undefined,
		reveal?: string,
		bottom = false,
		marks: Marks = { refs: new Map() },
	): void {
		const stick = this.atBottom();
		const top = this.root.scrollTop;
		for (const child of this.list.getChildren()) {
			this.list.remove(child);
			child.destroyRecursively();
		}
		for (const block of blocks) this.list.add(this.blockNode(block, selected, marks));
		if (notice) this.list.add(this.noticeNode(notice));
		setTimeout(() => this.settle(stick || bottom, top, reveal), SETTLE_MS);
	}

	scrollBy(lines: number): void {
		this.root.scrollBy(lines);
	}

	private atBottom(): boolean {
		return this.root.scrollTop + this.root.height >= this.root.scrollHeight - 1;
	}

	private settle(stick: boolean, top: number, reveal: string | undefined): void {
		if (reveal) this.root.scrollChildIntoView(reveal);
		else if (stick) this.root.scrollTop = this.root.scrollHeight;
		else this.root.scrollTop = top;
	}

	private blockNode(
		block: Block,
		selected: string | undefined,
		marks: Marks,
	): BoxRenderable | TextRenderable {
		if (block.type === 'message') return this.messageNode(block, marks, 0);
		if (block.type === 'discussion')
			return this.discussionNode(block, block.key === selected, marks);
		if (block.type === 'live') return this.liveNode(block);
		if (block.type === 'steps') return this.stepsNode(block);
		return this.text([paint(block.text, { color: palette.dim })]);
	}

	private text(chunks: Chunk[]): TextRenderable {
		return new TextRenderable(this.renderer, {
			content: new StyledText(chunks),
			wrapMode: 'word',
			width: '100%',
		});
	}

	private messageNode(block: MessageBlock, marks: Marks, indent: number): BoxRenderable {
		const focused = marks.focus === block.message.seq;
		const fill = focused ? palette.selected : block.role === 'steer' ? palette.steer : undefined;
		const box = new BoxRenderable(this.renderer, {
			id: `message-${block.message.seq}`,
			flexDirection: 'column',
			border: ['left'],
			borderColor: railOf[block.role],
			paddingLeft: 1,
			backgroundColor: fill ?? palette.bg,
		});
		const body = [paint(`\n${bodyOf(block.message)}`, { fill })];
		box.add(this.text([...headerOf(block, fill), ...body]));
		const width = Math.max(CHIP_MIN, this.root.width - CHIP_MARGIN - indent);
		for (const item of marks.refs.get(block.message.seq) ?? [])
			box.add(this.chip(item, item.id === marks.picked, width, fill));
		return box;
	}

	/** One line for one ref. A chosen ref shows a highlight, and a ref that does not resolve shows in red. */
	private chip(
		item: RefItem,
		picked: boolean,
		width: number,
		fill: string | undefined,
	): TextRenderable {
		const shade = picked ? palette.selected : fill;
		const color = item.resolved.target ? palette.accent : palette.red;
		return new TextRenderable(this.renderer, {
			content: new StyledText([paint(chipLine(item.resolved, width), { color, fill: shade })]),
			wrapMode: 'none',
			width: '100%',
		});
	}

	private discussionNode(block: DiscussionBlock, selected: boolean, marks: Marks): BoxRenderable {
		const fill = selected ? palette.selected : palette.bg;
		const row = new BoxRenderable(this.renderer, {
			id: `discussion-${block.key}`,
			backgroundColor: fill,
			width: '100%',
		});
		const count = `${block.count} ${block.count === 1 ? 'message' : 'messages'}`;
		const flag = tag(block.flag, palette.summary, fill);
		const cost = tag(block.cost, palette.muted, fill);
		const hint = tag(
			selected ? `Enter ${block.expanded ? 'closes' : 'opens'} it, s shows the steps` : '',
			palette.muted,
			fill,
		);
		row.add(
			this.text([
				paint(block.expanded ? '▾ ' : '▸ ', { color: palette.accent, fill }),
				paint('Discussion', { strong: true, fill }),
				paint(`  ${count}`, { color: palette.muted, fill }),
				paint(`  ${block.voices.join(', ')}`, {
					color: selected ? palette.muted : palette.dim,
					fill,
				}),
				flag,
				cost,
				hint,
			]),
		);
		if (!block.expanded) return row;
		const wrapper = new BoxRenderable(this.renderer, { flexDirection: 'column', gap: 1 });
		wrapper.add(row);
		const thread = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			gap: 1,
			marginLeft: 2,
		});
		for (const item of block.items) thread.add(this.messageNode(item, marks, 2));
		wrapper.add(thread);
		return wrapper;
	}

	private stepsNode(block: StepsBlock): BoxRenderable {
		const box = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			border: ['left'],
			borderColor: palette.accent,
			paddingLeft: 1,
		});
		const state = block.running ? '  running, no end step yet' : '';
		box.add(
			this.text([
				paint('Steps ', { color: palette.accent, strong: true }),
				paint(block.title, { color: palette.muted }),
				paint(state, { color: palette.coral }),
			]),
		);
		for (const pass of block.passes) {
			box.add(
				this.text([
					paint(`Pass ${pass.pass}`, { strong: true }),
					paint(`  reads ${pass.input} to ${pass.through}`, { color: palette.dim }),
				]),
			);
			for (const line of pass.lines) {
				const color = line.kind === 'error' ? palette.red : palette.muted;
				box.add(
					this.text([
						paint(`  ${line.kind.padEnd(9)}`, { color: palette.dim }),
						paint(line.text, { color }),
					]),
				);
			}
		}
		return box;
	}

	private liveNode(block: LiveBlock): TextRenderable {
		const detail = block.detail ? [paint(`   ${block.detail}`, { color: palette.dim })] : [];
		return this.text([
			paint('● ', { color: palette.coral }),
			paint(block.text, { color: palette.muted }),
			...detail,
			paint('   /abort cancels it', { color: palette.dim }),
		]);
	}

	private noticeNode(notice: string): TextRenderable {
		return this.text([paint(notice, { color: palette.muted })]);
	}
}
