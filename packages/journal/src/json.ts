const PLAIN = new Set(['Object', 'Array']);

/**
 * Throw when a value is not JSON: a plain object or array, a string, a
 * boolean, `null`, or a finite number. A field that holds `undefined` is not
 * JSON. The error names the path of the first fault. The journal calls it on
 * every body at append, so the memory journal and a JSON storage hold the same
 * values.
 */
export function assertJson(value: unknown, path = '$'): void {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number.`);
		return;
	}
	if (typeof value !== 'object') throw new Error(`${path} is a ${typeof value}.`);
	const tag = (value as object).constructor?.name ?? 'Object';
	if (!PLAIN.has(tag)) throw new Error(`${path} is a ${tag}.`);
	for (const [key, item] of Object.entries(value as Record<string, unknown>))
		assertMember(item, `${path}.${key}`);
}

function assertMember(item: unknown, path: string): void {
	if (item === undefined) throw new Error(`${path} is undefined.`);
	assertJson(item, path);
}

/** A copy of a JSON value that shares nothing with the original. */
export function detached<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
