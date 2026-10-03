import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import type { Process, ProcessEvent, Workspace } from '@ambionframework/workspace';
import { workspaceConformance } from '@ambionframework/workspace/conformance';
import { ImageRenderable, imageInfo, type TerminalCapabilities } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL, openHost } from '../src/host.ts';
import { localBashBackend } from '../src/local-bash.ts';
import { localGitBackend } from '../src/local-git.ts';
import { hostLogin, requireLogin } from '../src/login.ts';
import { cameraPreview } from '../src/preview.ts';
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

it('runs the seat on the login of the host, and the binary gets no key of the host', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'camera-chat-login-'));
	try {
		const env = { CODEX_HOME: join(directory, 'codex') };
		expect(hostLogin(env)).toBe(join(directory, 'codex', 'auth.json'));
		expect(hostLogin({ HOME: directory })).toBe(join(directory, '.codex', 'auth.json'));
		await expect(requireLogin(hostLogin(env))).rejects.toThrow(`Run 'codex login'`);
		await mkdir(env.CODEX_HOME);
		await writeFile(hostLogin(env), '{}');
		await requireLogin(hostLogin(env));
		// The seat runs a fake executable that records its environment and exits.
		const live = join(directory, 'live');
		const seen = join(directory, 'seen.env');
		const fake = join(directory, 'codex-fake.sh');
		await writeFile(fake, `#!/bin/sh\nenv > '${seen}'\nexit 1\n`, { mode: 0o755 });
		vi.stubEnv('CODEX_API_KEY', 'host-codex-key');
		vi.stubEnv('CODEX_ACCESS_TOKEN', 'host-codex-token');
		vi.stubEnv('OPENAI_API_KEY', 'host-openai-key');
		const host = await openHost({
			directory: live,
			model: DEFAULT_MODEL,
			login: hostLogin(env),
			codexPath: fake,
		});
		try {
			await host.visit.send({ text: 'Hello.', to: 'observer' });
			await expect
				.poll(() => readFile(seen, 'utf8').catch(() => ''), { timeout: 10000 })
				.not.toBe('');
		} finally {
			await host.close();
		}
		const variables = (await readFile(seen, 'utf8')).split('\n');
		// The binary gets no key of the host, and the seat keeps its own home.
		expect(variables.filter((line) => /API_KEY|ACCESS_TOKEN/.test(line))).toEqual([]);
		expect(variables).toContain(`CODEX_HOME=${join(live, 'codex')}`);
		// The seat links the file that startup checked.
		expect(await readlink(join(live, 'codex', 'auth.json'))).toBe(hostLogin(env));
	} finally {
		vi.unstubAllEnvs();
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

/** The answer cites the observation and the frame, and the snapshots hold their bytes. */
async function checkEvidence(
	host: Awaited<ReturnType<typeof openHost>>,
	refs: readonly string[] | undefined,
) {
	const [observationRef, frameRef] = refs ?? [];
	if (!observationRef || !frameRef) throw new Error('The answer cites no observation and frame.');
	const observation = JSON.parse(
		Buffer.from(await host.workspace.readSnapshot(observationRef)).toString(),
	);
	expect(observation).toMatchObject({
		api: 2,
		observations: [
			{ parts: [{ kind: 'frame', file: demoFrame().digest, mediaType: 'image/png' }] },
		],
	});
	const frame = Buffer.from(await host.workspace.readSnapshot(frameRef));
	expect(frame.equals(demoFrame().png)).toBe(true);
}

type Invoke = (name: string, args: object) => unknown;

/** After a cancel, `fetch` refuses the name. A new process of that name restarts the preview, and `fetch` reads it twice. */
async function startAgain(
	invoke: Invoke,
	host: Awaited<ReturnType<typeof openHost>>,
	previous: string,
): Promise<Process> {
	await expect(invoke('fetch', { process: 'camera', path: '/camera/observe' })).rejects.toThrow(
		"No running process is named 'camera'",
	);
	const started = await invoke('bash', {
		command: 'cd ~/camera && AMBION_SENSOR_REPOSITORY=observer/camera node main.ts --demo',
		name: 'camera',
		wait: 1,
		timeout: 86400,
	});
	const again = (started as { details: { process: Process } }).details.process;
	expect(again.handle).not.toBe(previous);
	await expect.poll(() => host.preview.latest?.digest).toBe(demoFrame().digest);
	expect(host.preview.handle).toBe(again.handle);
	const look = await invoke('fetch', { process: 'camera', path: '/camera/observe' });
	expect((look as { details: { status: number; handle: string } }).details).toMatchObject({
		status: 200,
		handle: again.handle,
	});
	const frame = await invoke('fetch', { process: 'camera', path: `/files/${demoFrame().digest}` });
	expect((frame as { details: { sha256: string } }).details.sha256).toBe(demoFrame().digest);
	return again;
}

it('clones and launches the actual template, reads it with fetch, and drives the preview lifecycle', async () => {
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
		await checkEvidence(host, answer && 'refs' in answer ? answer.refs : undefined);
		const camera = (await host.workspace.processes.list({ running: true })).find(
			(process) => process.name === 'camera',
		);
		if (!camera) throw new Error('No running camera process.');
		expect(camera.port).toBeGreaterThan(0);
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
		expect(host.preview.handle).toBe(camera.handle);
		setup.mockInput.pressKey('p', { ctrl: true });
		await expect.poll(() => modal?.visible).toBe(true);
		await invoke('cancel', { handle: camera.handle });
		await expect.poll(() => host.preview.handle).toBeUndefined();
		await setup.renderOnce();
		expect(modal?.visible).toBe(false);
		expect(host.preview.latest).toBeUndefined();
		expect(setup.renderer.root.findDescendantById(inlineId)).toBeDefined();
		expect(
			(await host.workspace.processes.list()).find((process) => process.handle === camera.handle)
				?.state,
		).toBe('exited');
		const again = await startAgain(invoke, host, camera.handle);
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
		await host.workspace.processes.cancel(again.handle);
		await expect.poll(() => host.preview.handle).toBeUndefined();
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
		expect(reopened.preview.handle).toBeUndefined();
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

it('follows the camera process, adopts one that runs at open, and downloads a frame once for one digest', async () => {
	const listeners: ((event: ProcessEvent) => void)[] = [];
	const digest = 'a'.repeat(64);
	const fetched: string[] = [];
	let failing = false;
	const process = (handle: string, name?: string) =>
		({ handle, ...(name ? { name } : {}), state: 'running' }) as Process;
	const workspace = {
		processes: {
			subscribe: (listener: (event: ProcessEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
			list: async () => [process('bash-other', 'build'), process('bash-adopted', 'camera')],
		},
		fetch: async (handle: string, path: string) => {
			fetched.push(`${handle} ${path}`);
			if (failing) return new Response('no', { status: 503 });
			return path.startsWith('/files/')
				? new Response(new Uint8Array([1]))
				: Response.json({
						observations: [
							{ at: new Date().toISOString(), parts: [{ kind: 'frame', file: digest }] },
						],
					});
		},
	} as unknown as Workspace;
	const preview = cameraPreview(workspace, () => {});
	const emit = (type: ProcessEvent['type'], handle: string, name?: string) =>
		listeners[0]?.({ type, process: process(handle, name) });
	try {
		await expect.poll(() => preview.handle).toBe('bash-adopted');
		await expect.poll(() => preview.latest?.digest).toBe(digest);
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(fetched.filter((call) => call.includes('/files/'))).toEqual([
			`bash-adopted /files/${digest}`,
		]);
		expect(fetched).toContain('bash-adopted /camera/observe');
		emit('started', 'bash-build', 'build');
		emit('ended', 'bash-build', 'build');
		expect(preview.handle).toBe('bash-adopted');
		failing = true;
		await expect.poll(() => preview.failure).toBe('Camera starting');
		expect(preview.latest?.digest).toBe(digest);
		emit('ended', 'bash-adopted', 'camera');
		expect(preview.handle).toBeUndefined();
		expect(preview.latest).toBeUndefined();
		failing = false;
		emit('started', 'bash-next', 'camera');
		expect(preview.handle).toBe('bash-next');
		await expect.poll(() => preview.latest?.digest).toBe(digest);
	} finally {
		preview.close();
	}
});

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
