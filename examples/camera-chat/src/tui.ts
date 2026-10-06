import type { Message } from '@ambionframework/ambion';
import type { Row } from '@ambionframework-examples/workbench/src/action-state.ts';
import { tui as palette } from '@ambionframework-examples/workbench/src/brand.ts';
import type { Block } from '@ambionframework-examples/workbench/src/timeline.ts';
import { Transcript } from '@ambionframework-examples/workbench/src/transcript.ts';
import { ActionsView } from '@ambionframework-examples/workbench/src/widget-actions.ts';
import {
	BoxRenderable,
	type CliRenderer,
	ImageRenderable,
	type KeyEvent,
	NativeImage,
	TextareaRenderable,
	TextRenderable,
} from '@opentui/core';
import type { CameraHost } from './host.ts';
import type { PreviewBinding, PreviewFrame } from './preview.ts';
import { referenceImages } from './reference-images.ts';
import { nativeProtocol } from './terminal.ts';

/** One floating box of a bound camera widget. */
interface Tile {
	readonly box: BoxRenderable;
	/** The actions of the widget, drawn under the box. */
	readonly actions: ActionsView;
	readonly picture: ImageRenderable;
	digest: string | undefined;
}

const KEYS =
	'Enter: send · Shift+Enter: newline · PgUp/PgDn: scroll · Ctrl+P: previews · Ctrl+C: quit';
const SCROLL_KEYS = new Set(['pageup', 'pagedown']);
const ACTION_KEY = 'Ctrl+L: actions · ';

/** The lines that the actions of one widget take at `width` cells. A button takes one line. */
function linesOf(rows: readonly Row[], width: number): number {
	const cells = Math.max(1, width - 4);
	return rows.reduce((sum, row) => {
		if (row.type === 'button') return sum + 1;
		const text = row.type === 'note' ? row.text : `   ${row.label}: ${row.value}`;
		return sum + Math.max(1, Math.ceil(text.length / cells));
	}, 0);
}

/** How many cameras fit in `budget` rows: each needs a box of three rows and its lines. At least one. */
function fitCount(lines: readonly number[], budget: number): number {
	let used = 0;
	let count = 0;
	for (const one of lines) {
		used += 3 + one;
		if (used > budget && count > 0) break;
		count++;
	}
	return count;
}

/** Workbench conversation widgets with floating, connection-driven camera previews, one for each bound widget. */
export function cameraView(renderer: CliRenderer, host: CameraHost, demo: boolean) {
	const protocol = nativeProtocol(renderer);
	let stopped = false;
	let sending = false;
	let reading = false;
	let dirty = false;
	let dismissed = false;
	let follows = 0;
	const { pad } = host;
	/** Whether a drawn camera has actions to press. */
	let actable = false;
	const tiles = new Map<string, Tile>();
	const size = { width: 42, height: 15 };
	let transcriptVersion = '';
	const root = new BoxRenderable(renderer, {
		width: '100%',
		height: '100%',
		flexDirection: 'column',
		padding: 1,
		gap: 1,
		backgroundColor: palette.bg,
	});
	const header = new BoxRenderable(renderer, {
		title: ' Ambion · Camera Chat ',
		border: true,
		borderColor: palette.line,
		titleColor: palette.accent,
		backgroundColor: palette.panel,
		paddingX: 1,
		flexDirection: 'column',
		flexShrink: 0,
	});
	header.add(
		new TextRenderable(renderer, {
			content: `room camera · Discuss camera observations${demo ? ' · DEMO' : ''}`,
			fg: palette.text,
		}),
	);
	header.add(
		new TextRenderable(renderer, {
			content: '● you · ○ observer · Ask the agent to connect the camera',
			fg: palette.muted,
		}),
	);
	const references = referenceImages(host.workspace);
	const transcript = new Transcript(renderer, (message) =>
		references.get(message).map((bytes, index) => {
			const box = new BoxRenderable(renderer, {
				id: `reference-image-${message.seq}-${index}`,
				width: size.width,
				height: size.height,
				border: true,
				borderColor: palette.line,
				flexDirection: 'column',
				flexShrink: 0,
				overflow: 'hidden',
			});
			box.add(
				new ImageRenderable(renderer, {
					id: `reference-frame-${message.seq}-${index}`,
					width: '100%',
					flexGrow: 1,
					minHeight: 0,
					fit: 'fit',
					protocol,
					source: bytes,
					onError: report,
				}),
			);
			return box;
		}),
	);
	const composer = new BoxRenderable(renderer, {
		border: true,
		title: ' Message the room ',
		borderColor: palette.line,
		backgroundColor: palette.panel,
		paddingX: 1,
		flexShrink: 0,
	});
	const input = new TextareaRenderable(renderer, {
		height: 3,
		width: '100%',
		placeholder: 'Connect the camera',
		placeholderColor: palette.dim,
		textColor: palette.text,
		focusedTextColor: palette.text,
		backgroundColor: palette.panel,
		focusedBackgroundColor: palette.panel,
		keyBindings: [
			{ name: 'return', action: 'submit' },
			{ name: 'return', shift: true, action: 'newline' },
		],
		onSubmit: () => {
			void send();
		},
	});
	composer.add(input);
	const status = new TextRenderable(renderer, { content: '', height: 2, fg: palette.muted });
	// The ruler reads the cell shape of the terminal for the size of a tile.
	const ruler = new ImageRenderable(renderer, { protocol });
	const chat = new BoxRenderable(renderer, {
		id: 'room-chat',
		width: '100%',
		height: '100%',
		flexDirection: 'column',
		gap: 1,
		minWidth: 0,
		minHeight: 0,
	});
	chat.add(header);
	chat.add(transcript.root);
	chat.add(composer);
	chat.add(status);
	root.add(chat);
	renderer.root.add(root);
	input.focus();
	async function send() {
		const text = input.plainText.trim();
		if (!text || sending) return;
		sending = true;
		try {
			await host.visit.send({ text, to: 'observer' });
			input.setText('');
		} catch (error) {
			report(error);
		} finally {
			sending = false;
			await refresh();
		}
	}
	function resize() {
		size.width = Math.max(22, Math.min(54, Math.floor(renderer.width * 0.38)));
		size.height = Math.max(
			1,
			Math.min(
				Math.floor(renderer.height * 0.48),
				Math.round(((size.width - 2) * 9) / (16 * ruler.cellAspectRatio)) + 2,
			),
		);
		paint();
		void refresh();
	}
	function tileOf(name: string): Tile {
		const found = tiles.get(name);
		if (found) return found;
		const box = new BoxRenderable(renderer, {
			id: `camera-modal-${name}`,
			position: 'absolute',
			right: 1,
			zIndex: 20,
			border: true,
			borderColor: palette.line,
			titleColor: palette.accent,
			flexDirection: 'column',
			overflow: 'hidden',
			visible: false,
		});
		const picture = new ImageRenderable(renderer, {
			id: `camera-frame-${name}`,
			width: '100%',
			flexGrow: 1,
			minHeight: 0,
			fit: 'fit',
			protocol,
			onError: report,
		});
		box.add(picture);
		root.add(box);
		const actions = new ActionsView(renderer);
		Object.assign(actions.root, { position: 'absolute', right: 1, zIndex: 20 });
		root.add(actions.root);
		const tile: Tile = { box, actions, picture, digest: undefined };
		tiles.set(name, tile);
		return tile;
	}
	function dropTile(name: string, tile: Tile) {
		tiles.delete(name);
		tile.box.destroyRecursively();
		tile.actions.root.destroyRecursively();
	}
	function paint() {
		if (stopped) return;
		if (follows !== host.preview.follows) {
			follows = host.preview.follows;
			dismissed = false;
		}
		host.preview.view(!dismissed);
		const shown = dismissed
			? []
			: host.preview.bindings.filter((binding) => binding.handle && binding.latest);
		layoutTiles(shown);
		// The pad leaves by itself when no drawn widget has an action. The composer takes the keys back.
		if (!pad.active && !input.focused) input.focus();
		status.content = statusText();
	}
	/** Drop the boxes of removed widgets, and hide the boxes of cameras that show no frame. */
	function syncTiles(shown: readonly PreviewBinding[]) {
		const names = new Set(host.preview.bindings.map((binding) => binding.name));
		for (const [name, tile] of tiles) {
			if (!names.has(name)) dropTile(name, tile);
			else if (!shown.some((binding) => binding.name === name)) hideTile(tile);
		}
	}
	/** The pad reads the widgets that the screen draws, in screen order. */
	function readActions(drawn: readonly PreviewBinding[]) {
		pad.sync(drawn.flatMap((binding) => host.actionWidget(binding.name) ?? []));
		return new Map(drawn.map((binding) => [binding.name, pad.rows(binding.name)]));
	}
	/**
	 * Stack one box for each shown camera at the top right, each with its actions under it. The
	 * stack gets the rows of the screen except the top row and the status. A box needs three
	 * rows, so a short terminal draws the first cameras that fit with their actions.
	 */
	function layoutTiles(shown: readonly PreviewBinding[]) {
		const budget = renderer.height - 2;
		let rows = readActions(shown);
		const count = fitCount(
			shown.map((binding) => linesOf(rows.get(binding.name) ?? [], size.width)),
			budget,
		);
		const fit = shown.slice(0, count);
		if (count < shown.length) rows = readActions(fit);
		syncTiles(fit);
		actable = fit.some((binding) => (rows.get(binding.name)?.length ?? 0) > 0);
		const lines = fit.map((binding) => linesOf(rows.get(binding.name) ?? [], size.width));
		const spare = budget - lines.reduce((sum, one) => sum + one, 0) - 3 * fit.length;
		const height = Math.max(
			3,
			Math.min(size.height, 3 + Math.floor(spare / Math.max(1, fit.length))),
		);
		let top = 1;
		fit.forEach((binding, index) => {
			const tile = tileOf(binding.name);
			Object.assign(tile.box, { width: size.width, height, top, visible: true });
			tile.box.title = ` ${[binding.name, binding.title].filter(Boolean).join(' · ')} `;
			if (binding.latest && binding.latest.digest !== tile.digest)
				updatePicture(tile, binding.latest);
			// Rows past the bottom of the screen are clipped.
			const room = Math.max(0, renderer.height - 1 - (top + height));
			tile.actions.draw(rows.get(binding.name) ?? []);
			Object.assign(tile.actions.root, {
				width: size.width,
				top: top + height,
				height: Math.min(lines[index] ?? 0, room),
			});
			top += height + (lines[index] ?? 0);
		});
		chat.width = fit.length ? Math.max(1, renderer.width - size.width - 4) : '100%';
	}
	function hideTile(tile: Tile) {
		tile.box.visible = false;
		tile.actions.draw([]);
		tile.picture.source = undefined;
		tile.digest = undefined;
	}
	function statusText() {
		const { bindings, notice } = host.preview;
		const failed = bindings.find((binding) => binding.failure);
		const line = [notice, failed ? `${failed.name}: ${failed.failure}` : host.activity]
			.filter(Boolean)
			.join(' · ');
		const cameras = bindings.filter((binding) => binding.handle).map((binding) => binding.name);
		const keys = pad.active ? pad.hint().join(' · ') : `${actable ? ACTION_KEY : ''}${KEYS}`;
		return `${cameras.length ? `Cameras: ${cameras.join(', ')} · ` : ''}${line}\n${keys}`;
	}
	function updatePicture(tile: Tile, frame: PreviewFrame) {
		try {
			const image = NativeImage.decode(frame.png);
			try {
				tile.picture.source = image;
				tile.digest = frame.digest;
			} finally {
				image.dispose();
			}
		} catch (error) {
			report(error);
		}
	}
	function showChat(messages: readonly Message[]) {
		const version = `${messages.at(-1)?.seq}:${host.activity}:${size.width}:${size.height}`;
		if (transcriptVersion === version) return;
		transcriptVersion = version;
		transcript.render(chatBlocks(messages, host.activity), undefined, undefined);
		status.content = statusText();
	}
	function report(error: unknown) {
		if (!stopped) status.content = String(error);
	}
	async function refresh() {
		dirty = true;
		if (reading || stopped) return;
		reading = true;
		dirty = false;
		try {
			const snapshot = await host.room.read();
			await references.load(snapshot.messages);
			if (!stopped) showChat(snapshot.messages);
		} catch (error) {
			report(error);
		} finally {
			reading = false;
		}
		paint();
		if (dirty) void refresh();
	}
	/** Give the keys to the actions of the viewfinders. A screen with none keeps the composer. */
	function enterActions() {
		if (!actable || !pad.enter()) return;
		input.blur();
		paint();
	}
	function leaveActions() {
		pad.leave();
		input.focus();
		paint();
	}
	/** The keys of the actions. A key with Ctrl falls through to the keys of the screen. */
	function actionKey(key: KeyEvent) {
		key.preventDefault();
		if (pad.key(key) === 'leave') leaveActions();
	}
	function screenKey(key: KeyEvent) {
		if (key.name === 'pageup') transcript.scrollBy(-8);
		if (key.name === 'pagedown') transcript.scrollBy(8);
		if (key.name === 'escape') {
			dismissed = true;
			paint();
		}
		if (key.ctrl && key.name === 'p') {
			dismissed = !dismissed;
			paint();
		}
	}
	const keys = (key: KeyEvent) => {
		if (pad.active && !key.ctrl && !SCROLL_KEYS.has(key.name)) actionKey(key);
		else if (key.ctrl && key.name === 'l') {
			key.preventDefault();
			enterActions();
		} else screenKey(key);
	};
	const unwatch = host.watch(() => {
		paint();
		void refresh();
	});
	renderer.on('resize', resize);
	renderer.keyInput.on('keypress', keys);
	resize();
	void refresh();
	return {
		close() {
			stopped = true;
			unwatch();
			renderer.off('resize', resize);
			renderer.keyInput.off('keypress', keys);
			for (const tile of tiles.values())
				if (!tile.picture.isDestroyed) tile.picture.source = undefined;
		},
	};
}

export async function runTui(renderer: CliRenderer, host: CameraHost, demo: boolean) {
	const view = cameraView(renderer, host, demo);
	const stop = () => renderer.destroy();
	renderer.keyInput.on('keypress', (key) => {
		if (key.ctrl && key.name === 'c') stop();
	});
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	process.once('SIGHUP', stop);
	try {
		await new Promise<void>((resolve) => renderer.once('destroy', resolve));
	} finally {
		view.close();
		process.off('SIGINT', stop);
		process.off('SIGTERM', stop);
		process.off('SIGHUP', stop);
	}
}

function chatBlocks(messages: readonly Message[], activity: string): Block[] {
	const blocks: Block[] = messages.flatMap((message): Block[] => {
		if (message.kind !== 'said' && message.kind !== 'summary') return [];
		return [
			{
				type: 'message',
				message,
				role: message.from === 'you' ? 'question' : message.kind === 'summary' ? 'summary' : 'said',
			},
		];
	});
	if (!blocks.length)
		blocks.push({
			type: 'note',
			text: 'Ask the agent to connect the camera. A preview appears while a camera process runs.',
		});
	if (activity !== 'Ready') blocks.push({ type: 'live', text: activity });
	return blocks;
}
