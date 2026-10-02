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
import type { PreviewFrame } from './preview.ts';
import { referenceImages } from './reference-images.ts';
import { nativeProtocol } from './terminal.ts';

/** Workbench conversation widgets with a floating, connection-driven camera preview. */
export function cameraView(renderer: CliRenderer, host: CameraHost, demo: boolean) {
	const protocol = nativeProtocol(renderer);
	let stopped = false;
	let sending = false;
	let reading = false;
	let dirty = false;
	let dismissed = false;
	let revision = 0;
	let displayedDigest: string | undefined;
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
				width: camera.width,
				height: camera.height,
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
	const camera = new BoxRenderable(renderer, {
		id: 'camera-modal',
		position: 'absolute',
		top: 1,
		right: 1,
		width: 42,
		height: 15,
		zIndex: 20,
		border: true,
		borderColor: palette.line,
		flexDirection: 'column',
		overflow: 'hidden',
		visible: false,
	});
	const picture = new ImageRenderable(renderer, {
		id: 'camera-frame',
		width: '100%',
		flexGrow: 1,
		minHeight: 0,
		fit: 'fit',
		protocol,
		onError: report,
	});
	camera.add(picture);
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
	root.add(camera);
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
		camera.width = Math.max(22, Math.min(54, Math.floor(renderer.width * 0.38)));
		camera.height = Math.max(
			1,
			Math.min(
				Math.floor(renderer.height * 0.48),
				Math.round(((camera.width - 2) * 9) / (16 * picture.cellAspectRatio)) + 2,
			),
		);
		paint();
		void refresh();
	}
	function paint() {
		if (stopped) return;
		if (revision !== host.preview.revision) {
			revision = host.preview.revision;
			dismissed = false;
		}
		fitChat();
		const frame = host.preview.latest;
		if (!frame) {
			picture.source = undefined;
			displayedDigest = undefined;
		} else if (frame.digest !== displayedDigest) updatePicture(frame);
		status.content = `${host.preview.failure ?? host.activity}\nEnter: send · Shift+Enter: newline · PgUp/PgDn: scroll · Ctrl+P: preview · Ctrl+C: quit`;
	}
	function fitChat() {
		camera.visible = Boolean(host.preview.sensor && host.preview.latest) && !dismissed;
		chat.width = camera.visible ? Math.max(1, renderer.width - camera.width - 4) : '100%';
	}
	function updatePicture(frame: PreviewFrame) {
		try {
			const image = NativeImage.decode(frame.png);
			try {
				picture.source = image;
				displayedDigest = frame.digest;
			} finally {
				image.dispose();
			}
		} catch (error) {
			report(error);
		}
	}
	function showChat(messages: readonly Message[]) {
		const version = `${messages.at(-1)?.seq}:${host.activity}:${camera.width}:${camera.height}`;
		if (transcriptVersion === version) return;
		transcriptVersion = version;
		transcript.render(chatBlocks(messages, host.activity), undefined, undefined);
		status.content = `${host.activity}\nEnter: send · Shift+Enter: newline · PgUp/PgDn: scroll · Ctrl+P: preview · Ctrl+C: quit`;
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
			if (!picture.isDestroyed) picture.source = undefined;
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
			text: 'Ask the agent to connect the camera. The preview appears after its sensor link is connected.',
		});
	if (activity !== 'Ready') blocks.push({ type: 'live', text: activity });
	return blocks;
}
