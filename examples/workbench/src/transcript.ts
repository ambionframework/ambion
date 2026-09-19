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
import type { Block, DiscussionBlock, LiveBlock, MessageBlock, Role } from './timeline.ts';

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

const clock = (at: string | undefined): string => {
	const date = at ? new Date(at) : undefined;
	if (!date || Number.isNaN(date.valueOf())) return '';
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

function bodyOf(message: Message): string {
	return message.kind === 'said' || message.kind === 'summary' ? (message.text ?? '') : '';
}

function headerOf(block: MessageBlock, fill?: string): Chunk[] {
	const { message, role } = block;
	const from = message.kind === 'said' || message.kind === 'summary' ? (message.from ?? '') : '';
	const to = message.kind === 'said' || message.kind === 'summary' ? message.to : undefined;
	const at = paint(`  ${clock(message.at)}`, { color: palette.dim, fill });
	if (role === 'question') return [paint(from, { strong: true, fill }), at];
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
	return [paint(from, { color: palette.accent, fill }), arrow, at];
}

const railOf: Record<Role, string> = {
	question: palette.text,
	said: palette.line,
	summary: palette.summary,
	steer: palette.accent,
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
	 * was not, or at the discussion the caller asks to reveal. The caller can also
	 * ask for the bottom, as after a notice or a message that the person sent.
	 */
	render(
		blocks: readonly Block[],
		selected: string | undefined,
		notice: string | undefined,
		reveal?: string,
		bottom = false,
	): void {
		const stick = this.atBottom();
		const top = this.root.scrollTop;
		for (const child of this.list.getChildren()) {
			this.list.remove(child);
			child.destroyRecursively();
		}
		for (const block of blocks) this.list.add(this.blockNode(block, selected));
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
		if (reveal) this.root.scrollChildIntoView(`discussion-${reveal}`);
		else if (stick) this.root.scrollTop = this.root.scrollHeight;
		else this.root.scrollTop = top;
	}

	private blockNode(block: Block, selected: string | undefined): BoxRenderable | TextRenderable {
		if (block.type === 'message') return this.messageNode(block);
		if (block.type === 'discussion') return this.discussionNode(block, block.key === selected);
		if (block.type === 'live') return this.liveNode(block);
		return this.text([paint(block.text, { color: palette.dim })]);
	}

	private text(chunks: Chunk[]): TextRenderable {
		return new TextRenderable(this.renderer, {
			content: new StyledText(chunks),
			wrapMode: 'word',
			width: '100%',
		});
	}

	private messageNode(block: MessageBlock): BoxRenderable {
		const fill = block.role === 'steer' ? palette.steer : undefined;
		const box = new BoxRenderable(this.renderer, {
			flexDirection: 'column',
			border: ['left'],
			borderColor: railOf[block.role],
			paddingLeft: 1,
			backgroundColor: fill ?? palette.bg,
		});
		const body = [paint(`\n${bodyOf(block.message)}`, { fill })];
		box.add(this.text([...headerOf(block, fill), ...body]));
		return box;
	}

	private discussionNode(block: DiscussionBlock, selected: boolean): BoxRenderable {
		const fill = selected ? palette.selected : palette.bg;
		const row = new BoxRenderable(this.renderer, {
			id: `discussion-${block.key}`,
			backgroundColor: fill,
			width: '100%',
		});
		const count = `${block.count} ${block.count === 1 ? 'message' : 'messages'}`;
		const flag = block.flag
			? paint(`  ${block.flag}`, { color: palette.summary, fill })
			: paint('', { fill });
		const hint = selected
			? paint(`  Enter ${block.expanded ? 'closes' : 'opens'} it`, { color: palette.muted, fill })
			: paint('', { fill });
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
		for (const item of block.items) thread.add(this.messageNode(item));
		wrapper.add(thread);
		return wrapper;
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
