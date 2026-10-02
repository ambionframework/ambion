import type {
	RegisteredSensorConnection,
	SensorConnectionEvent,
	Workspace,
} from '@ambionframework/workspace';

/** The preview reads a frame at this interval. */
const FRAME_MS = 200;
/** The preview rechecks the owning process at this interval. Link events end it sooner. */
const RECHECK_MS = 2000;

export interface PreviewFrame {
	at: string;
	digest: string;
	png: Uint8Array;
}

/** Read preview frames through the standard registry and sensor HTTP client. */
export function cameraPreview(workspace: Workspace, changed: () => void) {
	let sensor: string | undefined;
	let connection: RegisteredSensorConnection | undefined;
	let checked = 0;
	let latest: PreviewFrame | undefined;
	let failure: string | undefined;
	let controller = new AbortController();
	let reading = false;
	let stopped = false;
	let revision = 0;
	const detach = () => {
		controller.abort();
		controller = new AbortController();
		sensor = undefined;
		connection = undefined;
		checked = 0;
		latest = undefined;
		failure = undefined;
		changed();
	};
	const linked = (event: SensorConnectionEvent) => {
		if (event.type === 'connected' || event.type === 'refreshed') {
			if (!event.connection.sensors.some((item) => item.name === 'camera')) return;
			detach();
			sensor = `${event.connection.name}/camera`;
			revision++;
			changed();
			void poll();
		} else if (sensor?.startsWith(`${event.connection.name}/`)) detach();
	};
	async function resolveLink(name: string, signal: AbortSignal) {
		if (connection?.available && Date.now() - checked < RECHECK_MS) return connection;
		const link = await workspace.sensors?.get(name, signal);
		signal.throwIfAborted();
		connection = link;
		checked = Date.now();
		return link;
	}
	async function fetchFrame(name: string, signal: AbortSignal) {
		const link = await resolveLink(name, signal);
		if (!link) return undefined;
		const observation = await link.client.observe(
			name.slice(name.indexOf('/') + 1),
			{ api: 1 },
			signal,
		);
		const sample = observation.observations.at(-1);
		const part = sample?.parts.find((part) => part.kind === 'frame');
		if (!sample || !part || part.kind !== 'frame') throw new Error('The camera returned no image.');
		const file = await link.client.file(part.file, signal);
		return { at: sample.at, digest: part.file, png: file.bytes };
	}
	function accept(frame: PreviewFrame | undefined, signal: AbortSignal) {
		if (signal.aborted || stopped) return;
		if (!frame) return detach();
		latest = frame;
		failure = undefined;
		changed();
	}
	function report(error: unknown, signal: AbortSignal) {
		if (signal.aborted || stopped) return;
		failure = error instanceof Error ? error.message : String(error);
		changed();
	}
	async function poll() {
		if (stopped || reading || !sensor) return;
		reading = true;
		const name = sensor;
		const signal = controller.signal;
		try {
			accept(await fetchFrame(name, AbortSignal.any([signal, AbortSignal.timeout(2000)])), signal);
		} catch (error) {
			report(error, signal);
		} finally {
			reading = false;
		}
	}

	const unwatch = workspace.sensors?.subscribe(linked);
	const timer = setInterval(() => void poll(), FRAME_MS);
	return {
		get revision() {
			return revision;
		},
		get sensor() {
			return sensor;
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
			unwatch?.();
			controller.abort();
		},
	};
}
