/**
 * Throw when a value is not JSON: a plain object or array, a string, a
 * boolean, `null`, or a finite number. A field that holds `undefined` is not
 * JSON, and a hole of an array is not JSON. A cycle is not JSON. The error
 * names the path of the first fault. The journal calls it on every body at
 * append, so the memory journal and a JSON storage hold the same values.
 */
export function assertJson(value: unknown, path = '$'): void {
	walk(value, path, new WeakSet());
}

function walk(value: unknown, path: string, ancestors: WeakSet<object>): void {
	if (typeof value !== 'object' || value === null) {
		assertScalar(value, path);
		return;
	}
	if (ancestors.has(value)) throw new Error(`${path} is a cycle.`);
	if (!Array.isArray(value)) assertPlain(value, path);
	ancestors.add(value);
	for (const [key, item] of members(value)) walk(item, `${path}.${key}`, ancestors);
	ancestors.delete(value);
}

/** The members of an array by index, so a hole reads as `undefined`. */
function members(value: object): [string, unknown][] {
	if (!Array.isArray(value)) return Object.entries(value);
	return Array.from({ length: value.length }, (_, index) => [String(index), value[index]]);
}

function assertScalar(value: unknown, path: string): void {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number.`);
		return;
	}
	if (value === undefined) throw new Error(`${path} holds undefined.`);
	throw new Error(`${path} holds a ${typeof value}.`);
}

/** A plain object has no prototype, or a prototype that has none. This holds across realms. */
function assertPlain(value: object, path: string): void {
	const proto: unknown = Object.getPrototypeOf(value);
	if (proto === null) return;
	if (Object.getPrototypeOf(proto) === null) return;
	const name = (proto as { constructor?: { name?: unknown } }).constructor?.name;
	throw new Error(`${path} holds an instance of ${typeof name === 'string' ? name : 'a class'}.`);
}

/** A copy of a JSON value that shares nothing with the original. */
export function detached<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
