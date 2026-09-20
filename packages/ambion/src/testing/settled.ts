import type { Room, RoomRead } from '../room-host.ts';

export interface SettledOptions {
	/** Real milliseconds. The default is 10 000. */
	readonly timeout?: number;
}

const RECHECK_MS = 10;

const busy = (read: RoomRead): string[] =>
	read.participants.flatMap((p) => (p.kind === 'agent' && p.status !== 'idle' ? [p.name] : []));

const isSettled = (read: RoomRead): boolean =>
	read.exchange === undefined && busy(read).length === 0;

function timeoutError(room: string, read: RoomRead | undefined, timeout: number): Error {
	const active = read === undefined ? [] : busy(read);
	const exchange = read?.exchange === undefined ? 'none' : String(read.exchange.from);
	return new Error(
		`Room '${room}' did not settle within ${timeout} ms: active ${active.join(', ') || 'none'}; exchange ${exchange}.`,
	);
}

/**
 * Resolve with the first read that holds no open exchange and no active
 * agent. It reads at once, after every notification, and every 10 ms of real
 * time. It never calls `reconcile()`. A test that waits on an alarm advances
 * its fake clock.
 */
export function settled(
	room: Pick<Room, 'name' | 'read' | 'subscribe'>,
	options: SettledOptions = {},
): Promise<RoomRead> {
	const timeout = options.timeout ?? 10_000;
	return new Promise<RoomRead>((resolve, reject) => {
		let last: RoomRead | undefined;
		let done = false;
		let timer: ReturnType<typeof setInterval> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let off: () => void = () => {};
		const finish = (end: () => void) => {
			if (done) return;
			done = true;
			off();
			clearInterval(timer);
			clearTimeout(deadline);
			end();
		};
		const check = () =>
			room.read({ messages: false }).then(
				(read) => {
					last = read;
					if (isSettled(read)) finish(() => resolve(read));
				},
				(error: unknown) => finish(() => reject(error)),
			);
		off = room.subscribe(() => void check());
		timer = setInterval(() => void check(), RECHECK_MS);
		deadline = setTimeout(() => {
			finish(() => reject(timeoutError(room.name, last, timeout)));
		}, timeout);
		void check();
	});
}
