import type { Message } from '@ambionframework/ambion';
import { tui as palette } from '@ambionframework-examples/workbench/src/brand.ts';
import type { Block } from '@ambionframework-examples/workbench/src/timeline.ts';
import { Transcript } from '@ambionframework-examples/workbench/src/transcript.ts';
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
	readonly picture: ImageRenderable;
	digest: string | undefined;
}

const KEYS =
	'Enter: send · Shift+Enter: newline · PgUp/PgDn: scroll · Ctrl+P: previews · Ctrl+C: quit';

/** Workbench conversation widgets with floating, connection-driven camera previews, one for each bound widget. */
export function cameraView(renderer: CliRenderer, host: CameraHost, demo: boolean) {
	const protocol = nativeProtocol(renderer);
	let stopped = false;
	let sending = false;
	let reading = false;
	let dirty = false;
	let dismissed = false;
	let follows = 0;
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
		const tile: Tile = { box, picture, digest: undefined };
		tiles.set(name, tile);
		return tile;
	}
	function dropTile(name: string, tile: Tile) {
		tiles.delete(name);
		tile.box.destroyRecursively();
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
	/** Stack one box for each shown camera at the top right. The title of a box names its widget. */
	function layoutTiles(shown: readonly PreviewBinding[]) {
		// Each box needs three rows, so a short terminal draws the first boxes that fit.
		const fit = shown.slice(0, Math.max(1, Math.floor((renderer.height - 2) / 3)));
		syncTiles(fit);
		const each = fit.length > 1 ? Math.floor((renderer.height - 2) / fit.length) : size.height;
		const height = Math.max(3, Math.min(size.height, each));
		fit.forEach((binding, index) => {
			const tile = tileOf(binding.name);
			Object.assign(tile.box, {
				width: size.width,
				height,
				top: 1 + index * height,
				visible: true,
			});
			tile.box.title = ` ${[binding.name, binding.title].filter(Boolean).join(' · ')} `;
			if (binding.latest && binding.latest.digest !== tile.digest)
				updatePicture(tile, binding.latest);
		});
		chat.width = fit.length ? Math.max(1, renderer.width - size.width - 4) : '100%';
	}
	function hideTile(tile: Tile) {
		tile.box.visible = false;
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
		return `${cameras.length ? `Cameras: ${cameras.join(', ')} · ` : ''}${line}\n${KEYS}`;
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
	const keys = (key: KeyEvent) => {
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
