import {
	BoxRenderable,
	bg,
	type CliRenderer,
	fg,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import { tui as palette } from './brand.ts';
import { LIST_ROWS, sidePanel, windowStart } from './files-panel.ts';
import { label, type ProcessBrowser, stateText } from './process-browser.ts';
import type { ProcessOutput, ProcessView } from './workbench.ts';

const HINT = 'Up/Down choose   PgUp/PgDn scroll   x x cancel   Ctrl+Y copy   Esc close';

/** The widest a command gets in the list. The title shows it whole. */
const COMMAND_WIDTH = 60;

/** The color of the dot before each process: its state at a glance. */
function dotColor(process: ProcessView): string {
	if (process.state === 'running') return palette.coral;
	if (process.state === 'exited' && process.exitCode === 0) return palette.green;
	return process.state === 'cancelled' ? palette.dim : palette.red;
}

const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ⏎ ');

const clip = (text: string, width: number): string =>
	text.length > width ? `${text.slice(0, width - 1)}…` : text;

/** What the output area says about the size of the output. */
function outputNote(output: ProcessOutput, process: ProcessView): string {
	if (output.size === 0)
		return process.state === 'running' ? 'No output yet.' : 'The process wrote no output.';
	const size = output.size < 1024 ? `${output.size} B` : `${(output.size / 1024).toFixed(1)} KB`;
	if (output.text === '')
		return `The output is ${size}, too large for the panel: ${process.output}`;
	return output.truncated ? `The last part of ${size} of output.` : `${size} of output.`;
}

/** The processes panel: the background processes of the agents, and the output of the chosen one. */
export class ProcessesPanel {
	readonly root: BoxRenderable;
	private readonly renderer: CliRenderer;
	private readonly heading: TextRenderable;
	private readonly list: TextRenderable;
	private readonly title: TextRenderable;
	private readonly body: TextRenderable;
	private readonly scroll: ScrollBoxRenderable;
	private readonly hint: TextRenderable;
	private shown: string | undefined;

	constructor(renderer: CliRenderer) {
		this.renderer = renderer;
		this.root = sidePanel(renderer);
		this.heading = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'none' });
		this.list = new TextRenderable(renderer, {
			content: '',
			flexShrink: 0,
			height: LIST_ROWS,
			wrapMode: 'none',
		});
		this.title = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'word' });
		this.body = new TextRenderable(renderer, { content: '', wrapMode: 'char', width: '100%' });
		this.scroll = new ScrollBoxRenderable(renderer, {
			flexGrow: 1,
			scrollY: true,
			stickyScroll: true,
			stickyStart: 'bottom',
			backgroundColor: palette.panel,
			scrollbarOptions: {
				trackOptions: { backgroundColor: palette.bg, foregroundColor: palette.line },
			},
		});
		// The padding keeps the text clear of the scrollbar.
		const padded = new BoxRenderable(renderer, { paddingRight: 2, width: '100%' });
		padded.add(this.body);
		this.scroll.add(padded);
		this.hint = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'word' });
		for (const part of [this.heading, this.list, this.title, this.scroll, this.hint])
			this.root.add(part);
	}

	/** Give the panel the whole width, or a share of it beside the conversation. */
	fill(whole: boolean): void {
		this.root.width = whole ? '100%' : '55%';
	}

	/** Draw the browser's state. The output scrolls to its end when the chosen process changes. */
	draw(browser: ProcessBrowser): void {
		this.root.visible = browser.open;
		if (!browser.open) return;
		const now = Date.now();
		const running = browser.processes.filter((process) => process.state === 'running').length;
		this.heading.content = new StyledText([
			fg(palette.accent)('Processes'),
			fg(palette.dim)(`   ${running} running, ${browser.processes.length} in all`),
		]);
		this.list.content = this.rows(browser, now);
		this.drawChosen(browser, now);
		this.hint.content = new StyledText(
			browser.message ? [fg(palette.summary)(browser.message)] : [fg(palette.dim)(HINT)],
		);
	}

	private rows(browser: ProcessBrowser, now: number): StyledText {
		const processes = browser.processes;
		if (processes.length === 0)
			return new StyledText([
				fg(palette.muted)('No process yet. An agent starts one with its bash tool.'),
			]);
		const start = windowStart(browser.index, processes.length);
		const labels = processes.map((process) => process.name ?? process.handle);
		const width = Math.max(...labels.map((text) => text.length));
		const agents = Math.max(...processes.map((process) => process.agent.length));
		return new StyledText(
			processes.slice(start, start + LIST_ROWS).flatMap((process, offset) => {
				const chosen = start + offset === browser.index;
				const cancelling = browser.cancelling.has(process.handle) ? 'cancelling ' : '';
				const state = `${cancelling}${stateText(process, now)}`;
				const line = `${chosen ? '▸ ' : '  '}${(labels[start + offset] ?? '').padEnd(width)}  ${process.agent.padEnd(agents)}  ${state.padEnd(20)}  ${clip(oneLine(process.command), COMMAND_WIDTH)}`;
				const tail = offset === LIST_ROWS - 1 ? '' : '\n';
				const text = chosen
					? bg(palette.selected)(fg(palette.accent)(line))
					: fg(palette.muted)(line);
				return [fg(dotColor(process))('● '), text, fg(palette.muted)(tail)];
			}),
		);
	}

	private drawChosen(browser: ProcessBrowser, now: number): void {
		const process = browser.selected;
		if (browser.problem || !process) {
			const text = browser.problem ?? 'Choose a process to read its output.';
			this.title.content = new StyledText([fg(browser.problem ? palette.red : palette.dim)(text)]);
			this.body.content = '';
			this.shown = undefined;
			return;
		}
		const room = process.room ? `, in the room ${process.room}` : '';
		// The output of the process chosen before stays until the new one loads.
		const output = browser.output?.handle === process.handle ? browser.output : undefined;
		this.title.content = new StyledText([
			fg(palette.accent)(label(process)),
			fg(palette.dim)(`   ${process.agent}${room}, ${stateText(process, now)}\n`),
			fg(palette.text)(`$ ${process.command}\n`),
			fg(palette.dim)(output ? outputNote(output, process) : 'Reading the output.'),
		]);
		this.body.content = new StyledText([fg(palette.text)(output?.text ?? '')]);
		if (this.shown !== process.handle) this.scroll.scrollTop = this.scroll.scrollHeight;
		this.shown = process.handle;
	}

	scrollBy(lines: number): void {
		this.scroll.scrollBy(lines);
	}

	get page(): number {
		return Math.max(4, this.scroll.height - 1);
	}

	/** Copy text to the clipboard through the terminal. Return false when it cannot. */
	copy(text: string): boolean {
		return this.renderer.isOsc52Supported() && this.renderer.copyToClipboardOSC52(text);
	}
}
