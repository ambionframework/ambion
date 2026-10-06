import type { Canvas, CanvasEvent, CanvasWidget } from '@ambionframework/canvas';
import type { ProcessEvent, Workspace } from '@ambionframework/workspace';

/** The preview reads a frame at this interval. */
const FRAME_MS = 200;
/** One read of the camera may take this long. */
const READ_MS = 2000;
/** The most bytes of one frame. A larger body is a failed read. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** The most bytes of one observation. */
const MAX_OBSERVATION_BYTES = 1024 * 1024;
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

/** The most widgets that the preview binds. The preview ignores the others. */
export const MAX_BINDINGS = 4;

/** The widget that a binding follows: a shown `frame` with a process source. */
interface Target {
	readonly name: string;
	readonly title: string | undefined;
	readonly author: string;
	readonly handle: string;
	readonly path: string;
}

/** Read GET `path` of the process `handle`, and fail on any answer but 2xx. */
async function read(workspace: Workspace, handle: string, path: string, signal: AbortSignal) {
	if (!workspace.fetch) throw new Error('The workspace cannot read a process.');
	const response = await workspace.fetch(handle, path, { signal });
	if (!response.ok) throw new Error(`The camera answered ${response.status} for ${path}.`);
	return response;
}

/** The body of a response, or a failure when it holds more than `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
	const length = Number(response.headers.get('content-length') ?? 0);
	if (length > limit) throw new Error(`The camera body of ${length} bytes is over ${limit}.`);
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = response.body?.getReader();
	for (let part = await reader?.read(); part && !part.done; part = await reader?.read()) {
		total += part.value.byteLength;
		if (total > limit) {
			await reader?.cancel().catch(() => undefined);
			throw new Error(`The camera body is over ${limit} bytes.`);
		}
		chunks.push(part.value);
	}
	return Buffer.concat(chunks);
}

/** The latest frame of the process `handle`. The frame of `previous` is kept when its digest is current. */
async function readFrame(
	workspace: Workspace,
	handle: string,
	path: string,
	previous: PreviewFrame | undefined,
	signal: AbortSignal,
): Promise<PreviewFrame> {
	const bytes = await readCapped(
		await read(workspace, handle, path, signal),
		MAX_OBSERVATION_BYTES,
	);
	const body = JSON.parse(Buffer.from(bytes).toString('utf8')) as Observation;
	const sample = body.observations?.at(-1);
	const file = sample?.parts.find((part) => part.kind === 'frame')?.file;
	if (!sample || !file || !/^[0-9a-f]{64}$/.test(file))
		throw new Error('The camera returned no image.');
	if (file === previous?.digest) return { ...previous, at: sample.at };
	const image = await read(workspace, handle, `/files/${file}`, signal);
	return { at: sample.at, digest: file, png: await readCapped(image, MAX_FRAME_BYTES) };
}

/** The shown `frame` widgets of a room with a process source, in the order of the canvas. */
function targetsOf(widgets: readonly CanvasWidget[]): Target[] {
	return widgets.flatMap((widget): Target[] =>
		widget.state === 'shown' && widget.kind === 'frame' && widget.source?.type === 'process'
			? [
					{
						name: widget.name,
						title: widget.title,
						author: widget.author,
						handle: widget.source.handle,
						path: widget.source.path,
					},
				]
			: [],
	);
}

/** The targets to bind: the bound ones first, then the others, up to `MAX_BINDINGS`. */
function admit(wanted: readonly Target[], bound: ReadonlyMap<string, unknown>) {
	const ordered = [
		...wanted.filter((target) => bound.has(target.name)),
		...wanted.filter((target) => !bound.has(target.name)),
	];
	return { kept: ordered.slice(0, MAX_BINDINGS), ignored: ordered.slice(MAX_BINDINGS) };
}

/** Whether a canvas event is about the widgets of the room. */
function concerns(event: CanvasEvent, room: string): boolean {
	if (event.type === 'widget') return event.widget.room === room;
	return event.type === 'started' && event.room === room;
}

/** What a binding tells the preview. */
interface Hooks {
	readonly changed: () => void;
	/** Whether the person shows the previews. */
	readonly visible: () => boolean;
	/** A binding follows a new process. */
	readonly followed: () => void;
}

/** One widget of the room bound to one process, with its own timer, cap, and abort. */
function frameBinding(workspace: Workspace, first: Target, hooks: Hooks) {
	let target = first;
	let handle: string | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let latest: PreviewFrame | undefined;
	let failure: string | undefined;
	let controller = new AbortController();
	let reading = false;
	let closed = false;
	/** Whether the handle was checked against the processes of the author. */
	let checked = false;
	/** Whether the process of the handle ended. */
	let ended = false;
	const stopTimer = () => {
		clearInterval(timer);
		timer = undefined;
	};
	const startTimer = () => {
		if (timer || !handle || !hooks.visible() || closed) return;
		timer = setInterval(() => void poll(), FRAME_MS);
		void poll();
	};
	const abort = () => {
		controller.abort();
		controller = new AbortController();
	};
	const clear = () => {
		stopTimer();
		abort();
		handle = undefined;
		latest = undefined;
		failure = undefined;
		hooks.changed();
	};
	async function poll() {
		if (closed || reading || !handle) return;
		reading = true;
		const { signal } = controller;
		const frame = await readFrame(
			workspace,
			handle,
			target.path,
			latest,
			AbortSignal.any([signal, AbortSignal.timeout(READ_MS)]),
		).catch(() => undefined);
		reading = false;
		if (signal.aborted || closed) return;
		if (frame) latest = frame;
		failure = frame ? undefined : STARTING;
		hooks.changed();
	}
	const follow = () => {
		if (closed || handle === target.handle) return;
		if (handle) clear();
		handle = target.handle;
		hooks.followed();
		hooks.changed();
		startTimer();
	};
	/** Whether the author runs the process of the handle. */
	const runs = async (asked: Target) => {
		const running = await workspace.processes.list({ agent: asked.author, running: true });
		return running.some((process) => process.handle === asked.handle);
	};
	return {
		get name() {
			return target.name;
		},
		get title() {
			return target.title;
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
		/** Take the widget as it is now. A moved source drops the old process. */
		retarget(next: Target) {
			const moved =
				next.author !== target.author || next.handle !== target.handle || next.path !== target.path;
			const retitled = next.title !== target.title;
			target = next;
			if (moved) {
				checked = false;
				ended = false;
				if (handle) clear();
			} else if (retitled) hooks.changed();
		},
		/** Check once that the author runs the handle, then follow it. A failed list is tried again. */
		async verify() {
			if (checked || closed) return;
			checked = true;
			const asked = target;
			const found = await runs(asked).catch(() => undefined);
			if (found === undefined) checked = false;
			if (!found || closed || ended || asked.handle !== target.handle) return;
			follow();
		},
		/** The end of the bound process clears the frame, and the binding stays until a new `show`. */
		observe(event: ProcessEvent) {
			if (event.type !== 'ended' || event.process.handle !== target.handle) return;
			ended = true;
			if (handle) clear();
		},
		resume: startTimer,
		pause() {
			stopTimer();
			abort();
		},
		close() {
			closed = true;
			stopTimer();
			controller.abort();
		},
	};
}

/** One bound widget, as the host reads it. */
export type PreviewBinding = Pick<
	ReturnType<typeof frameBinding>,
	'name' | 'title' | 'handle' | 'latest' | 'failure'
>;

/**
 * Show the frames of the shown `frame` widgets of `room`, one binding for each widget name, and
 * `MAX_BINDINGS` at most. A widget names the handle of a process of its author and a path. A
 * binding checks once that the author runs the handle, then reads the path of that process by
 * handle with `workspace.fetch`, with no retention. The preview reads the widgets again on the
 * `started` event of the room and on each `widget` event. A `show` with another handle binds the
 * new handle. A hidden widget removes its binding. The `ended` event of the bound process clears
 * the frame of its binding, and the binding waits for a new `show`. It touches no other binding.
 */
export function cameraPreview(
	workspace: Workspace,
	canvas: Pick<Canvas, 'widgets' | 'subscribe'>,
	changed: () => void,
	room: string,
) {
	const bound = new Map<string, ReturnType<typeof frameBinding>>();
	let ignored: readonly string[] = [];
	let stopped = false;
	let visible = true;
	let follows = 0;
	const hooks: Hooks = {
		changed,
		visible: () => visible,
		followed: () => {
			follows++;
		},
	};
	/** Note the ignored widgets. True when the note changes. */
	function note(extra: readonly Target[]): boolean {
		const names = extra.map((target) => target.name);
		const same = names.length === ignored.length && names.every((name, i) => name === ignored[i]);
		ignored = names;
		return !same;
	}
	/** Close the bindings of widgets that are no longer wanted. True when one closes. */
	function drop(wanted: ReadonlySet<string>): boolean {
		const gone = [...bound.keys()].filter((name) => !wanted.has(name));
		for (const name of gone) {
			bound.get(name)?.close();
			bound.delete(name);
		}
		return gone.length > 0;
	}
	/** Read the widgets of the room, and bind the process handle that each frame widget names. */
	async function bind() {
		if (stopped) return;
		const { kept, ignored: extra } = admit(targetsOf(canvas.widgets(room)), bound);
		const changes = [note(extra), drop(new Set(kept.map((target) => target.name)))];
		for (const target of kept) {
			const binding = bound.get(target.name);
			if (binding) binding.retarget(target);
			else bound.set(target.name, frameBinding(workspace, target, hooks));
		}
		if (changes.includes(true)) changed();
		await Promise.all([...bound.values()].map((binding) => binding.verify()));
	}
	const unsubscribe = canvas.subscribe((event) => {
		if (concerns(event, room)) void bind();
	});
	const unwatch = workspace.processes.subscribe((event: ProcessEvent) => {
		for (const binding of bound.values()) binding.observe(event);
	});
	void bind();
	return {
		/** The count of processes that bindings followed. It rises on each new follow. */
		get follows() {
			return follows;
		},
		/** The bound widgets, in the order of binding. */
		get bindings(): readonly PreviewBinding[] {
			return [...bound.values()];
		},
		/** A note for the status line while the preview ignores widgets over the limit. */
		get notice() {
			return ignored.length
				? `The preview shows ${MAX_BINDINGS} cameras at most. Not shown: ${ignored.join(', ')}.`
				: undefined;
		},
		/** The person shows or hides the previews. Hidden previews read nothing. */
		view(shown: boolean) {
			if (visible === shown) return;
			visible = shown;
			for (const binding of bound.values()) {
				if (shown) binding.resume();
				else binding.pause();
			}
		},
		close() {
			stopped = true;
			unsubscribe();
			unwatch();
			for (const binding of bound.values()) binding.close();
		},
	};
}
