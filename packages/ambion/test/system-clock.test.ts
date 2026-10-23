/**
 * The system clock alarm reads the wall clock again at a fixed interval, so a
 * host that sleeps fires a due alarm soon after it wakes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../src/index.ts';

const HOUR = 3_600_000;

describe('the system clock alarm', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('fires at the due time, and not before', () => {
		const fired = vi.fn();
		systemClock().alarm(Date.now() + HOUR, fired);
		vi.advanceTimersByTime(HOUR - 1);
		expect(fired).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it('fires within one interval of a wake, when the wall clock jumped past the due time', () => {
		const fired = vi.fn();
		systemClock().alarm(Date.now() + HOUR, fired);
		// The host sleeps for five hours: the wall clock moves, and the timers do not.
		vi.setSystemTime(Date.now() + 5 * HOUR);
		expect(fired).not.toHaveBeenCalled();
		vi.advanceTimersByTime(30_000);
		expect(fired).toHaveBeenCalledTimes(1);
	});

	it('fires an alarm in the past at once, and nothing after a cancel', () => {
		const fired = vi.fn();
		const clock = systemClock();
		clock.alarm(Date.now() - 1, fired);
		vi.advanceTimersByTime(0);
		expect(fired).toHaveBeenCalledTimes(1);
		const cancelled = vi.fn();
		const cancel = clock.alarm(Date.now() + HOUR, cancelled);
		vi.advanceTimersByTime(HOUR / 2);
		cancel();
		vi.advanceTimersByTime(HOUR);
		expect(cancelled).not.toHaveBeenCalled();
	});
});
