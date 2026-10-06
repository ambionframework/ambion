import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import { createRuntime, defineAgent } from '@ambionframework/ambion';
import { describeExecutor } from '@ambionframework/ambion/hosting';
import { byAgent, scripted } from '@ambionframework/ambion/testing';
import { memoryCanvas, openCanvas } from '@ambionframework/canvas';
import { memoryJournals } from '@ambionframework/journal';
import type { Process, ProcessEvent, Workspace } from '@ambionframework/workspace';
import { workspaceConformance } from '@ambionframework/workspace/conformance';
import {
	BoxRenderable,
	ImageRenderable,
	imageInfo,
	type TerminalCapabilities,
} from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL, openHost } from '../src/host.ts';
import { localBashBackend } from '../src/local-bash.ts';
import { localGitBackend } from '../src/local-git.ts';
import { hostLogin, requireLogin } from '../src/login.ts';
import { cameraPreview, MAX_BINDINGS, MAX_FRAME_BYTES } from '../src/preview.ts';
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

type Host = Awaited<ReturnType<typeof openHost>>;

/** The agent calls `show` for the widget `name`, with the handle of the process that `bash` started. */
async function showFrame(
	host: Host,
	name: string,
	started: unknown,
	title: string,
	context: { agent: { name: string; identity: string } },
) {
	const show = host.canvas.widgetTools().tools.find((tool) => tool.name === 'show');
	const handle = (started as { details: { process: Process } }).details.process.handle;
	await show?.invoke(
		{
			name,
			kind: 'frame',
			title,
			source: { type: 'process', handle, path: '/camera/observe' },
			actions: [{ id: 'look', label: 'Look now' }],
		},
		{
			...context,
			callId: `show-${name}`,
			room: 'camera',
			activation: 'a-1',
			exchange: { from: 1 },
		},
	);
}

/** After a cancel, `fetch` refuses the name, and the widget stays. A `show` with the handle of a new process binds it, and `fetch` reads it twice. */
async function startAgain(
	invoke: Invoke,
	host: Host,
	previous: string,
	context: { agent: { name: string; identity: string } },
): Promise<Process> {
	await expect(invoke('fetch', { process: 'front', path: '/camera/observe' })).rejects.toThrow(
		"No running process is named 'front'",
	);
	const started = await invoke('bash', {
		command: 'cd ~/camera && AMBION_SENSOR_REPOSITORY=observer/camera node main.ts --demo',
		name: 'front',
		wait: 1,
		timeout: 86400,
	});
	const again = (started as { details: { process: Process } }).details.process;
	expect(again.handle).not.toBe(previous);
	// The new process has no binding until the agent shows its handle.
	expect(host.preview.bindings[0]?.handle).toBeUndefined();
	await showFrame(host, 'front', started, 'Front door', context);
	await expect.poll(() => host.preview.bindings[0]?.latest?.digest).toBe(demoFrame().digest);
	expect(host.preview.bindings[0]?.handle).toBe(again.handle);
	const look = await invoke('fetch', { process: 'front', path: '/camera/observe' });
	expect((look as { details: { status: number; handle: string } }).details).toMatchObject({
		status: 200,
		handle: again.handle,
	});
	const frame = await invoke('fetch', { process: 'front', path: `/files/${demoFrame().digest}` });
	expect((frame as { details: { sha256: string } }).details.sha256).toBe(demoFrame().digest);
	return again;
}

type Setup = Awaited<ReturnType<typeof createTestRenderer>>;

/** The viewfinder draws its `look` action. A press sends the act as a message of the person. */
async function checkLook(setup: Setup, host: Host) {
	await expect
		.poll(async () => {
			await setup.renderOnce();
			return setup.captureCharFrame();
		})
		.toContain('[ Look now ]');
	expect(setup.captureCharFrame()).toContain('Ctrl+L: actions');
	setup.mockInput.pressKey('l', { ctrl: true });
	await expect
		.poll(async () => {
			await setup.renderOnce();
			return setup.captureCharFrame();
		})
		.toContain('Enter press');
	expect(setup.captureCharFrame()).toContain('▸ [ Look now ]');
	setup.mockInput.pressEnter();
	const revision = host.canvas.widgets('camera')[0]?.revision;
	const pressed = async () =>
		(await host.room.read()).messages.find(
			(message) => message.kind === 'said' && message.key?.startsWith(`act:${revision}:`),
		);
	await expect.poll(pressed).toMatchObject({
		from: 'you',
		to: 'observer',
		text: expect.stringContaining('Look now [look]'),
	});
	await expect
		.poll(async () => {
			await setup.renderOnce();
			return setup.captureCharFrame();
		})
		.toContain('Sent as #');
	// The agent observes the camera that the press names, and answers.
	await expect
		.poll(async () =>
			(await host.room.read()).messages.some(
				(message) =>
					message.kind === 'said' &&
					message.from === 'observer' &&
					message.text.includes('fresh look at front') &&
					(message.refs?.length ?? 0) > 0,
			),
		)
		.toBe(true);
	// Escape leaves the actions, and the previews stay.
	setup.mockInput.pressEscape();
	await expect
		.poll(async () => {
			await setup.renderOnce();
			return setup.captureCharFrame();
		})
		.toContain('Ctrl+L: actions');
	expect(setup.renderer.root.findDescendantById('camera-modal-front')?.visible).toBe(true);
}

/** A second camera gets a second box, stacked under the first without overlap, and a hide removes one box. */
async function checkTwoCameras(
	setup: Setup,
	host: Host,
	invoke: Invoke,
	context: { agent: { name: string; identity: string }; callId: string },
) {
	// A second camera gets a second box, stacked under the first without overlap.
	const launch = (name: string) =>
		invoke('bash', {
			command: 'cd ~/camera && AMBION_SENSOR_REPOSITORY=observer/camera node main.ts --demo',
			name,
			wait: 1,
			timeout: 86400,
		});
	const hide = host.canvas.widgetTools().tools.find((tool) => tool.name === 'hide');
	const widgetContext = { ...context, room: 'camera', activation: 'a-1', exchange: { from: 1 } };
	await showFrame(host, 'desk', await launch('desk'), 'Desk', context);
	await showFrame(host, 'front', await launch('front'), 'Front door', context);
	const boxes = () => ['front', 'desk'].map((name) => `camera-modal-${name}`);
	const found = () =>
		boxes().map((id) => setup.renderer.root.findDescendantById(id)?.visible ?? false);
	await expect
		.poll(async () => {
			await setup.renderOnce();
			return found();
		})
		.toEqual([true, true]);
	const [upper, lower] = boxes().map((id) => setup.renderer.root.findDescendantById(id));
	// One row of actions sits between the boxes.
	expect((upper?.y ?? 0) + (upper?.height ?? 0) + 1).toBeLessThanOrEqual(lower?.y ?? 0);
	// A short terminal keeps both boxes with their actions above the status line.
	setup.resize(80, 16);
	await setup.renderOnce();
	await setup.renderOnce();
	const frame = setup.captureCharFrame();
	expect(frame.split('[ Look now ]')).toHaveLength(3);
	expect(frame).toContain('Cameras: front, desk');
	expect((lower?.y ?? 0) + (lower?.height ?? 0) + 1).toBeLessThanOrEqual(15);
	expect(lower instanceof BoxRenderable && lower.title).toBe(' desk · Desk ');
	expect(setup.captureCharFrame()).toContain('Cameras: front, desk');
	// A hide of one widget removes only its box.
	await hide?.invoke({ name: 'desk' }, { ...widgetContext, callId: 'hide-desk' });
	await expect
		.poll(async () => {
			await setup.renderOnce();
			return found();
		})
		.toEqual([true, false]);
	expect(host.preview.bindings.map((binding) => binding.name)).toEqual(['front']);
	await host.workspace.processes.cancel(
		(await host.workspace.processes.list({ running: true })).find((one) => one.name === 'front')
			?.handle ?? '',
	);
	await host.workspace.processes.cancel(
		(await host.workspace.processes.list({ running: true })).find((one) => one.name === 'desk')
			?.handle ?? '',
	);
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
		const chat = setup.renderer.root.findDescendantById('room-chat');
		const fullWidth = chat?.width;
		expect(setup.renderer.root.findDescendantById('camera-modal-front')).toBeUndefined();
		const messages = await (
			await host.visit.send({
				text: 'Connect the camera and tell me what you see.',
				to: 'observer',
			})
		).waitForClose();
		const answer = messages.find(
			(message) => message.kind === 'said' && message.from === 'observer',
		);
		expect(answer && 'text' in answer && answer.text).toContain('through the observe macro');
		await expect(
			invoke('bash', {
				command: `cd ~/camera && git push ${directory}/git/templates/camera.git HEAD:refs/heads/x`,
			}),
		).rejects.toThrow('A template is read-only');
		await checkEvidence(host, answer && 'refs' in answer ? answer.refs : undefined);
		const camera = (await host.workspace.processes.list({ running: true })).find(
			(process) => process.name === 'front',
		);
		if (!camera) throw new Error('No running camera process.');
		expect(camera.port).toBeGreaterThan(0);
		expect(host.canvas.widgets('camera')).toMatchObject([
			{
				name: 'front',
				title: 'Front door',
				kind: 'frame',
				state: 'shown',
				author: 'observer',
				source: { type: 'process', handle: camera.handle, path: '/camera/observe' },
			},
		]);
		expect(host.preview.bindings.map((binding) => binding.name)).toEqual(['front']);
		await expect.poll(() => host.preview.bindings[0]?.latest?.digest).toBe(demoFrame().digest);
		await setup.renderOnce();
		const modal = setup.renderer.root.findDescendantById('camera-modal-front');
		expect(modal?.visible).toBe(true);
		expect(modal instanceof BoxRenderable && modal.title).toBe(' front · Front door ');
		expect(setup.captureCharFrame()).toContain('Cameras: front');
		expect(modal?.x).toBeGreaterThan(60);
		expect(modal?.width).toBeLessThan(55);
		expect(modal?.height).toBeLessThan(18);
		expect(modal?.getChildren()).toHaveLength(1);
		expect(chat?.width).toBeLessThan(fullWidth ?? 0);
		expect((chat?.x ?? 0) + (chat?.width ?? 0)).toBeLessThan(modal?.x ?? 0);
		expect(setup.captureCharFrame()).not.toContain('Camera preview');
		expect(setup.captureCharFrame()).not.toContain('Frame ');
		await checkLook(setup, host);

		const picture = setup.renderer.root.findDescendantById('camera-frame-front');
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
		// The workspace reads the process through the global fetch.
		const reads = vi.spyOn(globalThis, 'fetch');
		const observed = () =>
			reads.mock.calls.filter(([url]) => String(url).endsWith('/camera/observe')).length;
		setup.mockInput.pressEscape();
		await expect.poll(() => modal?.visible).toBe(false);
		await setup.renderOnce();
		expect(chat?.width).toBe(fullWidth);
		expect(host.preview.bindings[0]?.handle).toBe(camera.handle);
		// A hidden preview reads nothing.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const hiddenReads = observed();
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(observed()).toBe(hiddenReads);
		setup.mockInput.pressKey('p', { ctrl: true });
		await expect.poll(() => modal?.visible).toBe(true);
		await expect.poll(observed).toBeGreaterThan(hiddenReads);
		reads.mockRestore();
		await invoke('cancel', { handle: camera.handle });
		await expect.poll(() => host.preview.bindings[0]?.handle).toBeUndefined();
		await setup.renderOnce();
		expect(modal?.visible).toBe(false);
		expect(host.preview.bindings[0]?.latest).toBeUndefined();
		// A stop is a cancel: the widget stays shown and draws nothing.
		expect(host.canvas.widgets('camera')).toMatchObject([{ name: 'front', state: 'shown' }]);
		expect(setup.renderer.root.findDescendantById(inlineId)).toBeDefined();
		expect(
			(await host.workspace.processes.list()).find((process) => process.handle === camera.handle)
				?.state,
		).toBe('exited');
		const again = await startAgain(invoke, host, camera.handle, context);
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
		await expect.poll(() => host.preview.bindings[0]?.handle).toBeUndefined();
		await setup.renderOnce();
		expect(modal?.visible).toBe(false);
		await checkTwoCameras(setup, host, invoke, context);
	} finally {
		vi.unstubAllEnvs();
		view.close();
		setup.renderer.destroy();
		capabilities.mockRestore();
		await host.close();
	}
	const reopened = await openHost(options);
	try {
		// The canvas resumes the room from its row, and the room keeps its record.
		expect(reopened.canvas.rooms()).toMatchObject([
			{ name: 'camera', depth: 0, state: 'running', start: { kind: 'root', agents: ['observer'] } },
		]);
		expect(reopened.canvas.room('camera')).toBe(reopened.room);
		// The widget row survives the restart, and no camera process runs to bind.
		expect(reopened.canvas.widgets('camera')).toMatchObject([
			{ name: 'front', state: 'shown' },
			{ name: 'desk', state: 'hidden' },
		]);
		expect(reopened.preview.bindings.map((binding) => binding.name)).toEqual(['front']);
		expect(reopened.preview.bindings[0]?.handle).toBeUndefined();
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

const digest = 'a'.repeat(64);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve when a count has not changed between two polls: the reads in flight have ended. */
async function quiet(count: () => number) {
	let last = -1;
	await expect
		.poll(
			() => {
				const same = count() === last;
				last = count();
				return same;
			},
			{ interval: 100 },
		)
		.toBe(true);
}

/** A process of the fake workspace. A later `start` is a newer start. */
const camera = (handle: string, start: number, agent = 'observer', name = 'front') =>
	({
		handle,
		name,
		agent,
		state: 'running',
		startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, start)).toISOString(),
	}) as Process;

/**
 * A workspace that holds a list of running processes and answers each read with a frame. `fetched`
 * records each read, and `body` answers a read of a file.
 */
function fakeWorkspace(running: Process[]) {
	const listeners: ((event: ProcessEvent) => void)[] = [];
	const fetched: string[] = [];
	const queries: unknown[] = [];
	const state = {
		failing: false,
		file: (): Response => new Response(new Uint8Array([1])),
	};
	const workspace = {
		processes: {
			subscribe: (listener: (event: ProcessEvent) => void) => {
				listeners.push(listener);
				return () => {};
			},
			list: async (query: { agent?: string }) => {
				queries.push(query);
				return running.filter((process) => process.agent === query.agent);
			},
		},
		fetch: async (handle: string, path: string) => {
			fetched.push(`${handle} ${path}`);
			if (state.failing) return new Response('no', { status: 503 });
			return path.startsWith('/files/')
				? state.file()
				: Response.json({
						observations: [
							{ at: new Date().toISOString(), parts: [{ kind: 'frame', file: digest }] },
						],
					});
		},
	} as unknown as Workspace;
	const emit = (type: ProcessEvent['type'], process: Process) => listeners[0]?.({ type, process });
	return { workspace, fetched, queries, running, state, emit };
}

const frameKind = {
	name: 'frame',
	description: 'A frame.',
	sources: ['process'],
	actions: false,
} as const;

/** The bound widget of that name, as the host reads it. */
const bound = (preview: ReturnType<typeof cameraPreview>, name = 'front') =>
	preview.bindings.find((binding) => binding.name === name);

/** A canvas with the room `camera` and the widget bundle of the observer, over one store and storage. */
async function viewfinderCanvas(store = memoryCanvas(), storage = memoryJournals()) {
	const runtime = createRuntime({ storage, execution: scripted(byAgent({})) });
	const canvas = openCanvas({
		name: 'cam',
		runtime,
		store,
		breakout: { team: [] },
		widgets: { kinds: [frameKind] },
	});
	const bundle = canvas.widgetTools();
	const agent = defineAgent({
		name: 'observer',
		identity: 'Observer.',
		executor: describeExecutor({ kind: 'scripted', instructions: 'Answer.', bundles: [bundle] }),
	});
	let calls = 0;
	const call = (tool: string, args: object) => {
		const found = bundle.tools.find((one) => one.name === tool);
		if (!found) throw new Error(`Missing ${tool}`);
		return found.invoke(args, {
			agent: { name: 'observer', identity: 'Observer.' },
			callId: `call-${++calls}`,
			room: 'camera',
			activation: 'act-1',
			exchange: { from: 1 },
		});
	};
	const show = (name = 'front', handle = `bash-${name}`) =>
		call('show', {
			name,
			kind: 'frame',
			title: `Camera ${name}`,
			source: { type: 'process', handle, path: '/camera/observe' },
		});
	const start = async () => {
		await canvas.resume({ agents: [agent] });
		await canvas.open({ name: 'camera', goal: 'Look.', agents: ['observer'] });
	};
	return { canvas, store, storage, call, show, start };
}

describe('the previews', () => {
	it('binds a shown frame widget by its handle, and rebinds on a new show', async () => {
		const { workspace, fetched, queries, running, emit } = fakeWorkspace([
			camera('bash-front', 1),
			camera('bash-other', 9, 'someone'),
			camera('bash-build', 9, 'observer', 'build'),
		]);
		const { canvas, show, call, start } = await viewfinderCanvas();
		await start();
		const preview = cameraPreview(workspace, canvas, () => {}, 'camera');
		try {
			// No widget, no read of the process list.
			expect(preview.bindings).toEqual([]);
			expect(queries).toEqual([]);
			// The handle of another agent binds nothing, and the preview reads nothing from it.
			await show('front', 'bash-other');
			await expect.poll(() => queries.length).toBe(1);
			expect(queries).toEqual([{ agent: 'observer', running: true }]);
			expect(bound(preview)?.title).toBe('Camera front');
			expect(bound(preview)?.handle).toBeUndefined();
			await wait(300);
			expect(fetched).toEqual([]);
			// The handle of a running process of the author binds, and one digest downloads once.
			await show('front', 'bash-front');
			await expect.poll(() => bound(preview)?.handle).toBe('bash-front');
			expect(queries).toHaveLength(2);
			await expect.poll(() => bound(preview)?.latest?.digest).toBe(digest);
			await wait(700);
			expect(fetched.filter((read) => read.includes('/files/'))).toEqual([
				`bash-front /files/${digest}`,
			]);
			expect(queries).toHaveLength(2);
			// A start of a process binds nothing: only a `show` with its handle does.
			const follows = preview.follows;
			running.push(camera('bash-next', 3));
			emit('started', camera('bash-next', 3));
			expect(bound(preview)?.handle).toBe('bash-front');
			// A new show with another handle binds that process.
			await show('front', 'bash-next');
			await expect.poll(() => bound(preview)?.handle).toBe('bash-next');
			expect(preview.follows).toBe(follows + 1);
			await expect.poll(() => bound(preview)?.latest?.digest).toBe(digest);
			// The end of another process changes nothing. The end of the bound one clears the frame.
			emit('ended', camera('bash-front', 1));
			expect(bound(preview)?.handle).toBe('bash-next');
			emit('ended', camera('bash-next', 3));
			expect(bound(preview)?.handle).toBeUndefined();
			expect(bound(preview)?.latest).toBeUndefined();
			expect(preview.bindings).toHaveLength(1);
			// A hide removes the binding and stops the reads.
			await call('hide', { name: 'front' });
			expect(preview.bindings).toEqual([]);
			await quiet(() => fetched.length);
			const reads = fetched.length;
			await wait(500);
			expect(fetched).toHaveLength(reads);
		} finally {
			preview.close();
			await canvas.close();
		}
	});

	it('binds two widgets, and a hide or a process end clears only that binding', async () => {
		const { workspace, fetched, running, emit } = fakeWorkspace([
			camera('bash-front', 1),
			camera('bash-desk', 1, 'observer', 'desk'),
		]);
		const { canvas, show, call, start } = await viewfinderCanvas();
		await start();
		const preview = cameraPreview(workspace, canvas, () => {}, 'camera');
		try {
			await show('front');
			await show('desk');
			await expect.poll(() => bound(preview, 'front')?.handle).toBe('bash-front');
			await expect.poll(() => bound(preview, 'desk')?.handle).toBe('bash-desk');
			await expect.poll(() => bound(preview, 'front')?.latest?.digest).toBe(digest);
			await expect.poll(() => bound(preview, 'desk')?.latest?.digest).toBe(digest);
			expect(preview.bindings.map((binding) => binding.title)).toEqual([
				'Camera front',
				'Camera desk',
			]);
			// The end of the process `desk` clears that binding alone.
			emit('ended', camera('bash-desk', 1, 'observer', 'desk'));
			expect(bound(preview, 'desk')?.handle).toBeUndefined();
			expect(bound(preview, 'desk')?.latest).toBeUndefined();
			expect(bound(preview, 'front')?.latest?.digest).toBe(digest);
			// A show of `desk` with a new handle binds it, and the other binding keeps its process.
			running.push(camera('bash-desk2', 2, 'observer', 'desk'));
			await show('desk', 'bash-desk2');
			await expect.poll(() => bound(preview, 'desk')?.handle).toBe('bash-desk2');
			expect(bound(preview, 'front')?.handle).toBe('bash-front');
			await expect.poll(() => bound(preview, 'desk')?.latest?.digest).toBe(digest);
			// A hide of `front` removes that binding alone and stops its reads.
			await call('hide', { name: 'front' });
			expect(preview.bindings.map((binding) => binding.name)).toEqual(['desk']);
			expect(bound(preview, 'desk')?.handle).toBe('bash-desk2');
			await quiet(() => fetched.filter((read) => read.startsWith('bash-front')).length);
			const reads = fetched.filter((read) => read.startsWith('bash-front')).length;
			await wait(500);
			expect(fetched.filter((read) => read.startsWith('bash-front'))).toHaveLength(reads);
			await expect
				.poll(() => fetched.filter((read) => read.startsWith('bash-desk2')).length)
				.toBeGreaterThan(1);
		} finally {
			preview.close();
			await canvas.close();
		}
	});

	it('binds at most four widgets, and ignores the others with a note', async () => {
		const names = ['a', 'b', 'c', 'd', 'e'];
		const { workspace } = fakeWorkspace(
			names.map((name, index) => camera(`bash-${name}`, index, 'observer', name)),
		);
		const { canvas, show, call, start } = await viewfinderCanvas();
		await start();
		const preview = cameraPreview(workspace, canvas, () => {}, 'camera');
		try {
			for (const name of names) await show(name);
			await expect.poll(() => bound(preview, 'd')?.handle).toBe('bash-d');
			expect(MAX_BINDINGS).toBe(4);
			expect(preview.bindings.map((binding) => binding.name)).toEqual(['a', 'b', 'c', 'd']);
			expect(preview.notice).toContain('e');
			// A hide frees a place, and the ignored widget takes it.
			await call('hide', { name: 'b' });
			await expect.poll(() => bound(preview, 'e')?.handle).toBe('bash-e');
			expect(preview.bindings.map((binding) => binding.name)).toEqual(['a', 'c', 'd', 'e']);
			expect(preview.notice).toBeUndefined();
		} finally {
			preview.close();
			await canvas.close();
		}
	});

	it('binds again from the rows when the room starts, and not for a hidden widget', async () => {
		const first = await viewfinderCanvas();
		await first.start();
		await first.show('front');
		await first.show('desk');
		await first.canvas.close();
		const restart = async () => {
			const { workspace } = fakeWorkspace([
				camera('bash-front', 1),
				camera('bash-desk', 1, 'observer', 'desk'),
			]);
			const again = await viewfinderCanvas(first.store, first.storage);
			// The preview exists before the canvas resumes, as the host builds it.
			const preview = cameraPreview(workspace, again.canvas, () => {}, 'camera');
			await again.start();
			return { ...again, preview };
		};
		const shown = await restart();
		try {
			expect(shown.canvas.widgets('camera')).toMatchObject([{ name: 'front' }, { name: 'desk' }]);
			await expect.poll(() => bound(shown.preview, 'front')?.handle).toBe('bash-front');
			await expect.poll(() => bound(shown.preview, 'desk')?.handle).toBe('bash-desk');
			await expect.poll(() => bound(shown.preview, 'desk')?.latest?.digest).toBe(digest);
			await shown.call('hide', { name: 'front' });
			expect(shown.preview.bindings.map((binding) => binding.name)).toEqual(['desk']);
			await shown.call('hide', { name: 'desk' });
			expect(shown.preview.bindings).toEqual([]);
		} finally {
			shown.preview.close();
			await shown.canvas.close();
		}
		const hidden = await restart();
		try {
			await expect
				.poll(() => hidden.canvas.widgets('camera').map((widget) => widget.state))
				.toEqual(['hidden', 'hidden']);
			expect(hidden.preview.bindings).toEqual([]);
		} finally {
			hidden.preview.close();
			await hidden.canvas.close();
		}
	});

	it('reads nothing while the person hides the previews, and reads again for both when it shows', async () => {
		const { workspace, fetched } = fakeWorkspace([
			camera('bash-front', 1),
			camera('bash-desk', 1, 'observer', 'desk'),
		]);
		const { canvas, show, start } = await viewfinderCanvas();
		await start();
		const preview = cameraPreview(workspace, canvas, () => {}, 'camera');
		const reads = (handle: string) => fetched.filter((read) => read.startsWith(handle)).length;
		try {
			await show('front');
			await show('desk');
			await expect.poll(() => bound(preview, 'front')?.latest?.digest).toBe(digest);
			await expect.poll(() => bound(preview, 'desk')?.latest?.digest).toBe(digest);
			preview.view(false);
			await quiet(() => fetched.length);
			const before = fetched.length;
			await wait(600);
			expect(fetched).toHaveLength(before);
			expect(preview.bindings.map((binding) => binding.handle)).toEqual([
				'bash-front',
				'bash-desk',
			]);
			const front = reads('bash-front');
			const desk = reads('bash-desk');
			preview.view(false);
			preview.view(true);
			await expect.poll(() => reads('bash-front')).toBeGreaterThan(front);
			await expect.poll(() => reads('bash-desk')).toBeGreaterThan(desk);
		} finally {
			preview.close();
			await canvas.close();
		}
	});

	it.each([
		[
			'a content length over the limit',
			() =>
				new Response(new Uint8Array([1]), {
					headers: { 'content-length': `${MAX_FRAME_BYTES + 1}` },
				}),
		],
		['a body over the limit', () => new Response(new Uint8Array(MAX_FRAME_BYTES + 1))],
	])('rejects %s, and reads the next frame', async (_label, oversize) => {
		const { workspace, state } = fakeWorkspace([camera('bash-front', 1)]);
		state.file = oversize;
		const { canvas, show, start } = await viewfinderCanvas();
		await start();
		const preview = cameraPreview(workspace, canvas, () => {}, 'camera');
		try {
			await show();
			await expect.poll(() => bound(preview)?.failure).toBe('Camera starting');
			expect(bound(preview)?.latest).toBeUndefined();
			state.file = () => new Response(new Uint8Array(MAX_FRAME_BYTES));
			await expect.poll(() => bound(preview)?.latest?.png.byteLength).toBe(MAX_FRAME_BYTES);
			expect(bound(preview)?.failure).toBeUndefined();
		} finally {
			preview.close();
			await canvas.close();
		}
	});
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

const run = promisify(execFile);
const gitIn = async (cwd: string, ...args: string[]) =>
	(await run('git', ['-C', cwd, ...args])).stdout.trim();

it('commits the template of the host onto a stale template, and a fork with its own commit merges it', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'camera-chat-template-'));
	try {
		const root = join(directory, 'git');
		const bare = join(root, 'templates', 'camera.git');
		await localGitBackend(root);
		const host = await gitIn(bare, 'rev-parse', 'main^{tree}');
		// A state directory of an earlier build holds a template with other files.
		const stale = join(directory, 'stale');
		await run('git', ['clone', '-q', bare, stale]);
		await writeFile(join(stale, 'server.ts'), '// stale\n');
		await gitIn(stale, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'Stale');
		await gitIn(bare, 'fetch', '-q', stale, 'HEAD:refs/heads/main', '--force');
		const old = await gitIn(bare, 'rev-parse', 'main');
		expect(await gitIn(bare, 'rev-parse', 'main^{tree}')).not.toBe(host);
		const fork = join(directory, 'fork');
		await run('git', ['clone', '-q', bare, fork]);
		await writeFile(join(fork, 'notes.md'), 'fork\n');
		await gitIn(fork, 'add', 'notes.md');
		await gitIn(fork, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'Fork');
		await localGitBackend(root);
		expect(await gitIn(bare, 'rev-parse', 'main^{tree}')).toBe(host);
		expect(await gitIn(bare, 'rev-parse', 'main^')).toBe(old);
		const tip = await gitIn(bare, 'rev-parse', 'main');
		// The command of the guidance.
		await gitIn(
			fork,
			'-c',
			'user.name=t',
			'-c',
			'user.email=t@t',
			'pull',
			'--no-rebase',
			'--no-edit',
			'-q',
			bare,
			'main',
		);
		await gitIn(fork, 'merge-base', '--is-ancestor', tip, 'HEAD');
		expect(await gitIn(fork, 'show', 'HEAD:notes.md')).toBe('fork');
		expect(await gitIn(fork, 'show', 'HEAD:server.ts')).toBe(
			await gitIn(bare, 'show', 'main:server.ts'),
		);
		await localGitBackend(root);
		expect(await gitIn(bare, 'rev-parse', 'main')).toBe(tip);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
