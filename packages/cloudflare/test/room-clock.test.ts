import { expect, it } from 'vitest';
import { RoomClock } from '../src/room-clock.ts';

function storage() {
	let alarm: number | undefined;
	return {
		get alarm() {
			return alarm;
		},
		async setAlarm(at: number) {
			alarm = at;
		},
		async deleteAlarm() {
			alarm = undefined;
		},
	};
}

it('keeps another room alarm when one room cancels its timer', async () => {
	const native = storage();
	const clock = new RoomClock(
		native,
		() => {},
		() => 0,
	);
	const cancelParent = clock.alarm(100, () => {});
	const cancelChild = clock.alarm(50, () => {});
	await clock.settled();
	expect(native.alarm).toBe(50);
	cancelChild();
	await clock.settled();
	expect(native.alarm).toBe(100);
	cancelParent();
	await clock.settled();
	expect(native.alarm).toBeUndefined();
});

it('fires due rooms independently and preserves future timers', async () => {
	const native = storage();
	let now = 10;
	const fired: string[] = [];
	const clock = new RoomClock(
		native,
		() => {},
		() => now,
	);
	clock.alarm(10, () => {
		fired.push('first');
		clock.alarm(30, () => fired.push('first again'));
	});
	clock.alarm(20, () => fired.push('second'));
	await clock.fire();
	expect(fired).toEqual(['first']);
	expect(native.alarm).toBe(20);
	now = 25;
	await clock.fire();
	expect(fired).toEqual(['first', 'second']);
	expect(native.alarm).toBe(30);
	now = 30;
	await clock.fire();
	expect(fired).toEqual(['first', 'second', 'first again']);
	expect(native.alarm).toBeUndefined();
});

it('serializes alarm writes when an earlier native write is delayed', async () => {
	const native = storage();
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let calls = 0;
	const clock = new RoomClock(
		{
			async setAlarm(at) {
				if (calls++ === 0) {
					entered();
					await held;
				}
				await native.setAlarm(at);
			},
			deleteAlarm: native.deleteAlarm,
		},
		() => {},
		() => 0,
	);
	const cancel = clock.alarm(100, () => {});
	await started;
	clock.alarm(50, () => {});
	cancel();
	release();
	await clock.settled();
	expect(native.alarm).toBe(50);
});

it('waits for every due callback, including async child work, before returning', async () => {
	const native = storage();
	const now = 10;
	let releaseFirst: () => void = () => {};
	let releaseSecond: () => void = () => {};
	const first = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	const second = new Promise<void>((resolve) => {
		releaseSecond = resolve;
	});
	let started = 0;
	let completed = 0;
	const clock = new RoomClock(
		native,
		() => {},
		() => now,
	);
	clock.alarm(10, async () => {
		started++;
		await first;
		completed++;
	});
	clock.alarm(10, async () => {
		started++;
		await second;
		completed++;
	});
	const fired = clock.fire();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(started).toBe(2);
	expect(completed).toBe(0);
	let returned = false;
	void fired.then(() => {
		returned = true;
	});
	releaseFirst();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(returned).toBe(false);
	releaseSecond();
	await fired;
	expect(completed).toBe(2);
	expect(native.alarm).toBeUndefined();
});

it('propagates a callback failure after scheduling the next alarm', async () => {
	const native = storage();
	const clock = new RoomClock(
		native,
		() => {},
		() => 10,
	);
	clock.alarm(10, () => {
		throw new Error('child reconciliation failed');
	});
	clock.alarm(20, () => {});
	await expect(clock.fire()).rejects.toThrow('child reconciliation failed');
	expect(native.alarm).toBe(20);
});

it('retries one transient native alarm failure', async () => {
	const native = storage();
	let attempts = 0;
	const clock = new RoomClock(
		{
			async setAlarm(at) {
				attempts++;
				if (attempts === 1) throw new Error('transient alarm failure');
				await native.setAlarm(at);
			},
			deleteAlarm: native.deleteAlarm,
		},
		() => {},
		() => 0,
	);
	clock.alarm(100, () => {});
	await clock.settled();
	expect(attempts).toBe(2);
	expect(native.alarm).toBe(100);
});

it('surfaces a native alarm failure after the bounded retry', async () => {
	let attempts = 0;
	const clock = new RoomClock(
		{
			async setAlarm() {
				attempts++;
				throw new Error('alarm unavailable');
			},
			async deleteAlarm() {},
		},
		() => {},
		() => 0,
	);
	clock.alarm(100, () => {});
	await expect(clock.settled()).rejects.toThrow('alarm unavailable');
	expect(attempts).toBe(2);
});
