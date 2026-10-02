import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { sensorConformance, workspaceConformance } from '@ambionframework/workspace/conformance';
import { ImageRenderable, imageInfo, type TerminalCapabilities } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL, openHost, seatOptions } from '../src/host.ts';
import { localBashBackend } from '../src/local-bash.ts';
import { localGitBackend } from '../src/local-git.ts';
import { hostLogin, requireLogin } from '../src/login.ts';
import { nativeProtocol } from '../src/terminal.ts';
import { cameraView } from '../src/tui.ts';
import { parseCameras } from '../templates/camera/camera.ts';
import {
	demoFrame,
	encodeFrame,
	FRAME_BYTES,
	FrameDecoder,
	HEIGHT,
	WIDTH,
} from '../templates/camera/frame.ts';
import { openSensor } from '../templates/camera/server.ts';

it('decodes split RGB frames and preserves 720p pixels in a valid PNG', async () => {
	const frame = demoFrame();
	expect((await encodeFrame(frame.rgb, frame.at)).png.equals(frame.png)).toBe(true);
	expect(imageInfo(frame.png)).toMatchObject({ width: 1280, height: 720 });
	const decoder = new FrameDecoder();
	expect(decoder.push(frame.rgb.subarray(0, 123))).toEqual([]);
	const frames = decoder.push(Buffer.concat([frame.rgb.subarray(123), frame.rgb]));
	expect(frames).toHaveLength(2);
	expect(frames.every((pixels) => pixels.equals(frame.rgb))).toBe(true);
	expect(FRAME_BYTES).toBe(WIDTH * HEIGHT * 3);
	const idatLength = frame.png.readUInt32BE(33);
	const rows = inflateSync(frame.png.subarray(41, 41 + idatLength));
	expect(rows.length).toBe(HEIGHT * (WIDTH * 3 + 1));
	expect(rows.subarray(1, WIDTH * 3 + 1).equals(frame.rgb.subarray(0, WIDTH * 3))).toBe(true);
});

it('finds the Codex login of the host and names the fix when it is missing', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'camera-chat-login-'));
	try {
		const env = { CODEX_HOME: join(directory, 'codex') };
		expect(hostLogin(env)).toBe(join(directory, 'codex', 'auth.json'));
		expect(hostLogin({ HOME: directory })).toBe(join(directory, '.codex', 'auth.json'));
		await expect(requireLogin(hostLogin(env))).rejects.toThrow(`Run 'codex login'`);
		await mkdir(env.CODEX_HOME);
		await writeFile(hostLogin(env), '{}');
		await requireLogin(hostLogin(env));
		const live = await openHost({
			directory: join(directory, 'live'),
			model: DEFAULT_MODEL,
			login: hostLogin(env),
		});
		await live.close();
		// The seat links the file that startup checked, and the binary gets no key of the host.
		expect(seatOptions(join(directory, 'live'), hostLogin(env))).toEqual({
			home: join(directory, 'live', 'codex'),
			login: hostLogin(env),
			env: { CODEX_API_KEY: undefined, OPENAI_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined },
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it('lists video inputs separately from audio', () => {
	expect(
		parseCameras(
			'[avfoundation] AVFoundation video devices:\n[avfoundation] [0] FaceTime HD Camera (Built-in)\n[avfoundation] AVFoundation audio devices:\n[avfoundation] [0] MacBook Microphone\n',
		),
	).toEqual([{ index: '0', name: 'FaceTime HD Camera (Built-in)' }]);
});

it('clones and launches the actual template, connects through standard tools, and drives the preview lifecycle', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'camera-chat-lifecycle-'));
	const options = { directory, model: DEFAULT_MODEL, demo: true };
	const host = await openHost(options);
	const setup = await createTestRenderer({ width: 120, height: 35 });
	expect(() => cameraView(setup.renderer, host, true)).toThrow('Native images are unavailable');
	const capabilities = vi
		.spyOn(setup.renderer, 'capabilities', 'get')
		.mockReturnValue(kittyTerminal);
	const view = cameraView(setup.renderer, host, true);
	const context = { agent: { name: 'observer', identity: 'Observer' }, callId: 'lifecycle-test' };
	const invoke = (name: string, args: object) => {
		const tool = host.workspace.tools().tools.find((tool) => tool.name === name);
		if (!tool) throw new Error(`Missing ${name}`);
		return tool.invoke(args, context);
	};
	try {
		expect(host.workspace.tools().tools.some((tool) => tool.name === 'observe_camera')).toBe(false);
		expect(await host.workspace.processes.list()).toEqual([]);
		vi.stubEnv('OPENAI_API_KEY', 'host-only-key');
		const shell = JSON.stringify(await invoke('bash', { command: 'env' }));
		expect(shell).toContain(`HOME=${directory}/workspace/homes/observer`);
		expect(shell).not.toContain('host-only-key');
		await setup.renderOnce();
		const modal = setup.renderer.root.findDescendantById('camera-modal');
		const chat = setup.renderer.root.findDescendantById('room-chat');
		const fullWidth = chat?.width;
		expect(modal?.visible).toBe(false);
		const messages = await (
			await host.visit.send({
				text: 'Connect the camera and tell me what you see.',
				to: 'observer',
			})
		).waitForClose();
		const answer = messages.find(
			(message) => message.kind === 'said' && message.from === 'observer',
		);
		expect(answer && 'text' in answer && answer.text).toContain('received a synthetic frame');
		await expect(
			invoke('bash', {
				command: `cd ~/camera && git push ${directory}/git/templates/camera.git HEAD:refs/heads/x`,
			}),
		).rejects.toThrow('A template is read-only');
		const reference = answer && 'refs' in answer ? answer.refs?.[0] : undefined;
		if (!reference) throw new Error('No retained observation manifest.');
		const manifest = JSON.parse(
			Buffer.from(await host.workspace.readSnapshot(reference)).toString(),
		);
		expect(manifest).toMatchObject({
			sensor: 'camera/camera',
			source: { repository: 'observer/camera', dirty: false },
		});
		await expect.poll(() => host.preview.latest?.digest).toBe(demoFrame().digest);
		await setup.renderOnce();
		expect(modal?.visible).toBe(true);
		expect(modal?.x).toBeGreaterThan(60);
		expect(modal?.width).toBeLessThan(55);
		expect(modal?.height).toBeLessThan(18);
		expect(modal?.getChildren()).toHaveLength(1);
		expect(chat?.width).toBeLessThan(fullWidth ?? 0);
		expect((chat?.x ?? 0) + (chat?.width ?? 0)).toBeLessThan(modal?.x ?? 0);
		expect(setup.captureCharFrame()).not.toContain('Camera preview');
		expect(setup.captureCharFrame()).not.toContain('Frame ');

		const picture = setup.renderer.root.findDescendantById('camera-frame');
		if (!(picture instanceof ImageRenderable)) throw new Error('No native image renderer.');
		await expect.poll(() => picture.image?.width).toBe(1280);
		expect(picture.image?.height).toBe(720);
		const inlineId = `reference-image-${answer?.seq}-0`;
		await expect.poll(() => setup.renderer.root.findDescendantById(inlineId)).toBeDefined();
		await setup.renderOnce();
		const inline = setup.renderer.root.findDescendantById(inlineId);
		expect(inline?.width).toBe(modal?.width);
		expect(inline?.height).toBe(modal?.height);
		const savedPicture = setup.renderer.root.findDescendantById(`reference-frame-${answer?.seq}-0`);
		expect(savedPicture).toBeInstanceOf(ImageRenderable);
		await expect.poll(() => (savedPicture as ImageRenderable).image?.width).toBe(1280);
		expect((savedPicture as ImageRenderable).image?.height).toBe(720);
		expect(inline?.parent?.id).toBe(`message-${answer?.seq}`);
		expect(setup.captureCharFrame()).toContain('Ambion');
		setup.mockInput.pressEscape();
		await expect.poll(() => modal?.visible).toBe(false);
		await setup.renderOnce();
		expect(chat?.width).toBe(fullWidth);
		expect(host.preview.sensor).toBe('camera/camera');
		setup.mockInput.pressKey('p', { ctrl: true });
		await expect.poll(() => modal?.visible).toBe(true);
		const link = (await host.workspace.sensors?.list())?.[0];
		if (!link) throw new Error('No registered camera.');
		await invoke('disconnect', { name: 'camera' });
		await setup.renderOnce();
		expect(modal?.visible).toBe(false);
		expect(host.preview.latest).toBeUndefined();
		expect(setup.renderer.root.findDescendantById(inlineId)).toBeDefined();
		expect(
			(await host.workspace.processes.list()).find((process) => process.handle === link.process)
				?.state,
		).toBe('running');
		await expect(invoke('observe', { sensor: 'camera/camera' })).rejects.toThrow(
			'unknown or unavailable',
		);
		await invoke('connect', { name: 'camera', process: link.process, port: link.port });
		await expect.poll(() => host.preview.latest?.digest).toBe(demoFrame().digest);
		await setup.renderOnce();
		expect(modal?.visible).toBe(true);
		setup.resize(80, 25);
		await setup.renderOnce();
		expect(modal?.width).toBeLessThan(35);
		await expect
			.poll(() => setup.renderer.root.findDescendantById(inlineId)?.width)
			.toBe(modal?.width);
		expect(setup.renderer.root.findDescendantById(inlineId)?.height).toBe(modal?.height);
		expect((chat?.x ?? 0) + (chat?.width ?? 0)).toBeLessThan(modal?.x ?? 0);
		await host.workspace.processes.cancel(link.process);
		await expect.poll(() => host.preview.sensor).toBeUndefined();
		await setup.renderOnce();
		expect(modal?.visible).toBe(false);
	} finally {
		vi.unstubAllEnvs();
		view.close();
		setup.renderer.destroy();
		capabilities.mockRestore();
		await host.close();
	}
	const reopened = await openHost(options);
	try {
		expect(reopened.preview.sensor).toBeUndefined();
		expect(
			(await reopened.room.read()).messages.some(
				(message) => message.kind === 'said' && message.from === 'observer',
			),
		).toBe(true);
	} finally {
		await reopened.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);

/** A simulated terminal advertising native Kitty graphics. */
const kittyTerminal: TerminalCapabilities = {
	kitty_keyboard: true,
	kitty_graphics: true,
	rgb: true,
	ansi256: true,
	unicode: 'unicode',
	sgr_pixels: true,
	color_scheme_updates: false,
	explicit_width: false,
	scaled_text: false,
	sixel: false,
	focus_tracking: true,
	sync: true,
	bracketed_paste: true,
	hyperlinks: true,
	osc52: false,
	osc52_support: 'unsupported',
	notifications: false,
	explicit_cursor_positioning: false,
	remote: false,
	multiplexer: 'none',
	terminal: { name: 'kitty', version: '', from_xtversion: true },
};

it('requires pixel dimensions for Sixel without a block fallback', async () => {
	const setup = await createTestRenderer({ width: 120, height: 35 });
	const capabilities = vi
		.spyOn(setup.renderer, 'capabilities', 'get')
		.mockReturnValue({ ...kittyTerminal, kitty_graphics: false, sixel: true });
	const resolution = vi.spyOn(setup.renderer, 'resolution', 'get').mockReturnValue(null);
	try {
		expect(() => nativeProtocol(setup.renderer)).toThrow('Native images are unavailable');
		resolution.mockReturnValue({ width: 1200, height: 700 });
		expect(nativeProtocol(setup.renderer)).toBe('sixel');
	} finally {
		resolution.mockRestore();
		capabilities.mockRestore();
		setup.renderer.destroy();
	}
});

it('passes the standard sensor conformance cases with the standalone camera server', async () => {
	const frame = demoFrame();
	const source = { repository: 'observer/camera', commit: 'a'.repeat(40), dirty: false };
	const cases = sensorConformance(
		{
			name: 'camera-template',
			async open() {
				const server = await openSensor(source);
				server.receive(frame);
				return {
					async request(method, path, body) {
						const reply = await fetch(`http://127.0.0.1:${server.port}${path}`, {
							method,
							...(body === undefined ? {} : { body: JSON.stringify(body) }),
						});
						const contentType = reply.headers.get('content-type');
						return {
							status: reply.status,
							contentType,
							...(contentType === 'image/png'
								? { bytes: new Uint8Array(await reply.arrayBuffer()) }
								: { body: await reply.json() }),
						};
					},
					dispose: server.close,
				};
			},
		},
		{
			span: { from: '2026-09-29T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
			sensors: [
				{
					name: 'camera',
					spans: false,
					latest: [
						{
							at: frame.at,
							parts: [{ kind: 'frame', file: frame.digest, mediaType: 'image/png' }],
						},
					],
					withinSpan: [],
				},
			],
			files: [{ digest: frame.digest, bytes: frame.png }],
		},
	);
	for (const item of cases) await item.run();
});

describe('local bash backend', () => {
	for (const c of workspaceConformance({
		name: 'local',
		async open() {
			const directory = await mkdtemp(join(tmpdir(), 'camera-chat-conformance-'));
			const backend = localBashBackend(
				`${directory}/workspace`,
				await localGitBackend(`${directory}/git`),
			);
			return {
				backend,
				dispose: async () => {
					await backend.dispose?.();
					await rm(directory, { recursive: true, force: true });
				},
			};
		},
	}))
		it(c.name, c.run);
});
