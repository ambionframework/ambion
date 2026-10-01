/** The size that a refusal or a guidance text shows a reader. */

const UNITS = [
	[1024 ** 3, 'GiB'],
	[1024 ** 2, 'MiB'],
	[1024, 'KiB'],
] as const;

/**
 * `bytes` in the largest unit that fits: GiB, MiB, or KiB. A value shows
 * whole when the unit divides it evenly, and with one decimal otherwise.
 * Below 1 KiB, the text is the byte count.
 */
export function formatBytes(bytes: number): string {
	const unit = UNITS.find(([size]) => bytes >= size);
	if (unit === undefined) return `${bytes} bytes`;
	const [size, name] = unit;
	const value = bytes / size;
	return `${Number.isInteger(value) ? value : value.toFixed(1)} ${name}`;
}
