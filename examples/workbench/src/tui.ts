import {
	BoxRenderable,
	type CliRenderer,
	createCliRenderer,
	type KeyEvent,
	TextRenderable,
} from '@opentui/core';
import { tui as palette } from './brand.ts';
import { parse } from './commands.ts';
import { Composer } from './composer.ts';
import { Painter } from './draw.ts';
import { FilesPanel } from './files-panel.ts';
import { Keys } from './keys.ts';
import { Palette } from './palette.ts';
import { type Intent, Session } from './session.ts';
import { Transcript } from './transcript.ts';
import { type OpenOptions, openWorkbench, type Person, type Workbench } from './workbench.ts';

/** How often the slow fallback reads the room list and a stopped room. */
const SLOW_MS = 4_000;

/** The cells between the terminal edge and the content, on each side. */
const PADDING = 1;

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/**
 * The terminal. It builds the widgets, the session, and the input, and wires
 * them together. It holds no rules of its own: the session owns the state, the
 * painter draws it, and the keys route the input.
 */
class WorkbenchTui {
	private readonly renderer: CliRenderer;
	private readonly session: Session;
	private readonly composer: Composer;
	private readonly painter: Painter;
	private readonly palette: Palette;
	private readonly keys: Keys;
	private stopped = false;

	constructor(renderer: CliRenderer, host: Workbench, identity: Person | undefined) {
		this.renderer = renderer;
		this.session = new Session(host, identity, () => this.render());
		const header = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'none' });
		const transcript = new Transcript(renderer);
		const panel = new FilesPanel(renderer);
		const body = new BoxRenderable(renderer, {
			flexDirection: 'row',
			flexGrow: 1,
			gap: 1,
			minHeight: 0,
		});
		this.composer = new Composer(renderer, {
			submit: () => void this.onSubmit(),
			change: () => this.keys.refreshPalette(),
		});
		this.painter = new Painter({
			session: this.session,
			transcript,
			composer: this.composer,
			panel,
			header,
			width: () => renderer.width - 2 * PADDING,
		});
		this.palette = new Palette(this.composer);
		this.keys = new Keys({
			renderer,
			session: this.session,
			composer: this.composer,
			palette: this.palette,
			painter: this.painter,
			panel,
			transcript,
			render: () => this.render(),
		});
		const root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			width: '100%',
			height: '100%',
			padding: PADDING,
			gap: 1,
			backgroundColor: palette.bg,
		});
		root.add(header);
		body.add(transcript.root);
		body.add(panel.root);
		root.add(body);
		root.add(this.composer.root);
		renderer.root.add(root);
		renderer.keyInput.on('keypress', (key: KeyEvent) => {
			this.keys.onKey(key);
			this.followEdit();
		});
		renderer.on('resize', () => this.render());
		this.composer.focus();
		this.render();
	}

	/** Run until the renderer is destroyed. */
	async run(): Promise<void> {
		const slow = setInterval(() => void this.session.poll(), SLOW_MS);
		await new Promise<void>((resolve) => {
			this.renderer.once('destroy', () => {
				this.stopped = true;
				clearInterval(slow);
				resolve();
			});
			void this.begin();
		});
	}

	private async begin(): Promise<void> {
		await this.session.start();
		// Nobody is chosen yet: fill the composer so the person chooses who to act as.
		if (!this.session.identity) this.composer.setText('/user ');
	}

	async leave(): Promise<void> {
		await this.session.leave();
	}

	/**
	 * The input reports a typed edit late: measured at up to 4 s, until the next repaint.
	 * So the palette reads the text one macrotask after the key, when the input has applied it.
	 */
	private followEdit(): void {
		setTimeout(() => {
			if (!this.stopped) this.keys.refreshPalette();
		}, 0);
	}

	private render(): void {
		if (this.stopped) return;
		this.keys.reconcile();
		this.painter.render(this.keys.mode, this.keys.browsing);
		this.keys.refreshPalette();
	}

	private async onSubmit(): Promise<void> {
		const row = this.palette.current;
		if (row && !row.run) {
			this.composer.setText(row.insert);
			return;
		}
		const text = row ? row.insert : this.composer.text;
		const isMessage = !this.session.awaitingGoal && parse(text).kind === 'message';
		const intent = await this.session.submit(text);
		// A message that failed to send stays in the box, so the person can send it again.
		if (!(isMessage && this.session.error)) this.composer.setText('');
		if (intent) this.apply(intent);
	}

	private apply(intent: Intent): void {
		if (intent.type === 'quit') this.renderer.destroy();
		else if (intent.type === 'compose') this.composer.setText(intent.text);
		else this.keys.openFiles();
	}
}

/** OpenTUI draws through Node's FFI, which Node enables only with a flag. */
async function openRenderer(): Promise<CliRenderer> {
	try {
		return await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
	} catch (error) {
		const detail = errorText(error);
		if (!/FFI/i.test(detail)) throw error;
		throw new Error(
			`${detail}\nStart the Workbench with \`pnpm start\`. It passes --experimental-ffi to Node.`,
		);
	}
}

export interface RunOptions {
	/** Where the journals and the workspace live. */
	directory: string;
	/** The person to act as. Without one, the terminal asks. */
	person?: string;
	/** A model stream, for tests. */
	stream?: OpenOptions['stream'];
}

/**
 * Run the Workbench: host the rooms and show the terminal, in this process. The rooms
 * are active while the terminal runs. When it ends, the person leaves and the rooms stop.
 */
export async function runWorkbench(options: RunOptions): Promise<void> {
	const host = await openWorkbench({ directory: options.directory, stream: options.stream });
	try {
		const identity = options.person
			? host.people.find((person) => person.name === options.person)
			: undefined;
		if (options.person && !identity) {
			const names = host.people.map((person) => person.name).join(', ');
			throw new Error(`Unknown person '${options.person}'. Pick one of ${names}.`);
		}
		const renderer = await openRenderer();
		renderer.setBackgroundColor(palette.bg);
		const app = new WorkbenchTui(renderer, host, identity);
		const stop = () => renderer.destroy();
		process.once('SIGTERM', stop);
		process.once('SIGHUP', stop);
		try {
			await app.run();
		} finally {
			process.off('SIGTERM', stop);
			process.off('SIGHUP', stop);
			await app.leave();
		}
	} finally {
		await host.close();
	}
}
