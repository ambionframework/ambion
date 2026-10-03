import type { Process, ProcessEvent, Workspace } from '@ambionframework/workspace';

/** The preview reads a frame at this interval. */
const FRAME_MS = 200;
/** One read of the camera may take this long. */
const READ_MS = 2000;
/** The name of the process that the preview follows. */
const CAMERA = 'camera';
/** The text of the status line while a read fails. */
const STARTING = 'Camera starting';

export interface PreviewFrame {
	at: string;
	digest: string;
	png: Uint8Array;
}

/** The part of an observation that the preview reads. */
interface Observation {
	readonly observations?: readonly {
		readonly at: string;
		readonly parts: readonly { readonly kind: string; readonly file?: string }[];
	}[];
}

/** Read GET `path` of the process `handle`, and fail on any answer but 2xx. */
async function read(workspace: Workspace, handle: string, path: string, signal: AbortSignal) {
	if (!workspace.fetch) throw new Error('The workspace cannot read a process.');
	const response = await workspace.fetch(handle, path, { signal });
	if (!response.ok) throw new Error(`The camera answered ${response.status} for ${path}.`);
	return response;
}

/** The latest frame of the camera `handle`. The frame of `previous` is kept when its digest is current. */
async function readFrame(
	workspace: Workspace,
	handle: string,
	previous: PreviewFrame | undefined,
	signal: AbortSignal,
): Promise<PreviewFrame> {
	const body = (await (
		await read(workspace, handle, '/camera/observe', signal)
	).json()) as Observation;
	const sample = body.observations?.at(-1);
	const file = sample?.parts.find((part) => part.kind === 'frame')?.file;
	if (!sample || !file || !/^[0-9a-f]{64}$/.test(file))
		throw new Error('The camera returned no image.');
	if (file === previous?.digest) return { ...previous, at: sample.at };
	const bytes = await (await read(workspace, handle, `/files/${file}`, signal)).arrayBuffer();
	return { at: sample.at, digest: file, png: new Uint8Array(bytes) };
}

/**
 * Show the frames of the process named `camera` of the agent `agent`. The preview follows the
 * process events of the workspace: a `started` event of that name starts a
 * timer that reads the camera with `workspace.fetch`, with no retention,
 * and its `ended` event stops the timer and clears the frame.
 */
export function cameraPreview(workspace: Workspace, changed: () => void, agent: string) {
	let handle: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let latest: PreviewFrame | undefined;
	let failure: string | undefined;
	let controller = new AbortController();
	let reading = false;
	let stopped = false;
	let revision = 0;
	const stop = () => {
		clearInterval(timer);
		timer = undefined;
		controller.abort();
		controller = new AbortController();
		handle = undefined;
		latest = undefined;
		failure = undefined;
		changed();
	};
	async function poll() {
		if (stopped || reading || !handle) return;
		reading = true;
		const { signal } = controller;
		const frame = await readFrame(
			workspace,
			handle,
			latest,
			AbortSignal.any([signal, AbortSignal.timeout(READ_MS)]),
		).catch(() => undefined);
		reading = false;
		if (signal.aborted || stopped) return;
		if (frame) latest = frame;
		failure = frame ? undefined : STARTING;
		changed();
	}
	const follow = (process: Process) => {
		if (stopped || handle === process.handle) return;
		if (handle) stop();
		handle = process.handle;
		revision++;
		timer = setInterval(() => void poll(), FRAME_MS);
		changed();
		void poll();
	};
	const unwatch = workspace.processes.subscribe((event: ProcessEvent) => {
		if (event.type === 'started' && event.process.name === CAMERA) follow(event.process);
		else if (event.type === 'ended' && event.process.handle === handle) stop();
	});
	// The list names the agent, so it reads the files of an agent that has not acted since the
	// host started. The read adopts a camera of an earlier run, and one list finds it.
	void workspace.processes.list({ agent, running: true }).then(
		(running) => {
			const found = running.find((process) => process.name === CAMERA);
			if (found) follow(found);
		},
		() => {},
	);
	return {
		get revision() {
			return revision;
		},
		get handle() {
			return handle;
		},
		get latest() {
			return latest;
		},
		get failure() {
			return failure;
		},
		close() {
			stopped = true;
			clearInterval(timer);
			unwatch();
			controller.abort();
		},
	};
}
