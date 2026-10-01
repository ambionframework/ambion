/** The size that a refusal or a guidance text shows a reader. */

/** The units from 1 KiB up. A size at 1024 of a unit shows in the next one. */
const UNITS = ['KiB', 'MiB'] as const;

/** `value` whole when it is a whole number, and with one decimal otherwise. */
function shown(value: number, unit: string): string {
	return `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit}`;
}

/**
 * `bytes` in the largest unit that fits: GiB, MiB, or KiB. A value shows
 * whole when the unit divides it evenly, and with one decimal otherwise.
 * A value that rounds to 1024 of a unit shows in the next unit. Below 1
 * KiB, the text is the byte count.
 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} bytes`;
	let value = bytes / 1024;
	for (const unit of UNITS) {
		if (Number(value.toFixed(1)) < 1024) return shown(value, unit);
		value /= 1024;
	}
	return shown(value, 'GiB');
}
