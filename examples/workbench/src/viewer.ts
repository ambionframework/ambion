import {
	BoxRenderable,
	type CliRenderer,
	fg,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import { tui as palette } from './brand.ts';
import type { FileContent } from './workbench.ts';

const bytes = (size: number): string =>
	size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;

const HINT = 'Esc close   Up/Down PageUp/PageDown scroll   Home/End jump   y copy';

/** A workspace file, shown over the conversation. It scrolls and copies. */
export class Viewer {
	readonly root: BoxRenderable;
	private readonly renderer: CliRenderer;
	private readonly title: TextRenderable;
	private readonly body: TextRenderable;
	private readonly scroll: ScrollBoxRenderable;
	private readonly hint: TextRenderable;
	private text = '';
	private flashing: ReturnType<typeof setTimeout> | undefined;

	constructor(renderer: CliRenderer) {
		this.renderer = renderer;
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			flexGrow: 1,
			border: true,
			borderColor: palette.line,
			backgroundColor: palette.panel,
			paddingLeft: 1,
			paddingRight: 1,
			visible: false,
		});
		this.title = new TextRenderable(renderer, { content: '', flexShrink: 0 });
		this.body = new TextRenderable(renderer, { content: '', wrapMode: 'word', width: '100%' });
		this.scroll = new ScrollBoxRenderable(renderer, {
			flexGrow: 1,
			scrollY: true,
			backgroundColor: palette.panel,
			scrollbarOptions: {
				trackOptions: { backgroundColor: palette.bg, foregroundColor: palette.line },
			},
		});
		this.scroll.add(this.body);
		this.hint = new TextRenderable(renderer, { content: '', flexShrink: 0 });
		this.root.add(this.title);
		this.root.add(this.scroll);
		this.root.add(this.hint);
	}

	get visible(): boolean {
		return this.root.visible;
	}

	/** Show a file from its first line. */
	open(file: FileContent): void {
		this.text = file.text;
		const lines = file.text.split('\n').length;
		const meta = `${bytes(new TextEncoder().encode(file.text).length)}, ${lines} ${lines === 1 ? 'line' : 'lines'}${file.truncated ? ', truncated' : ''}`;
		this.title.content = new StyledText([
			fg(palette.accent)(file.path),
			fg(palette.dim)(`   ${meta}`),
		]);
		this.body.content = new StyledText([fg(palette.text)(file.text)]);
		this.hint.content = new StyledText([fg(palette.dim)(HINT)]);
		this.scroll.scrollTop = 0;
		this.root.visible = true;
	}

	close(): void {
		clearTimeout(this.flashing);
		this.root.visible = false;
	}

	/** Replace the key hints with a short message, then bring the hints back. */
	flash(message: string): void {
		this.hint.content = new StyledText([fg(palette.summary)(message)]);
		clearTimeout(this.flashing);
		this.flashing = setTimeout(() => {
			this.hint.content = new StyledText([fg(palette.dim)(HINT)]);
		}, 1_800);
	}

	scrollBy(lines: number): void {
		this.scroll.scrollBy(lines);
	}

	scrollTo(top: number): void {
		this.scroll.scrollTop = top;
	}

	get end(): number {
		return this.scroll.scrollHeight;
	}

	get page(): number {
		return Math.max(4, this.scroll.height - 1);
	}

	/** Copy the file's text to the clipboard through the terminal. Return false when it cannot. */
	copy(): boolean {
		return this.renderer.isOsc52Supported() && this.renderer.copyToClipboardOSC52(this.text);
	}
}
