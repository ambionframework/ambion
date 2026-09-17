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
