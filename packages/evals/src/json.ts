import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function toJsonValue(value: unknown, label: string): JsonValue {
	assertSerializable(value, label);
	return cloneJson(value);
}

export function assertSerializable(value: unknown, label: string): asserts value is JsonValue {
	validateJson(value, label, new Set<object>());
}

function validateJson(
	value: unknown,
	label: string,
	seen: Set<object>,
): asserts value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number') return validateNumber(value, label);
	if (value === undefined) throw new TypeError(`${label} contains undefined.`);
	if (typeof value !== 'object') throw new TypeError(`${label} contains ${typeof value}.`);
	if (seen.has(value)) throw new TypeError(`${label} contains a cycle.`);
	seen.add(value);
	try {
		if (Array.isArray(value)) validateArray(value, label, seen);
		else validateObject(value, label, seen);
	} finally {
		seen.delete(value);
	}
}

function validateNumber(value: number, label: string): void {
	if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number.`);
}

function validateArray(value: readonly unknown[], label: string, seen: Set<object>): void {
	for (let index = 0; index < value.length; index += 1)
		validateJson(value[index], `${label}[${index}]`, seen);
}

function validateObject(value: object, label: string, seen: Set<object>): void {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new TypeError(`${label} contains a non-plain object.`);
	for (const [key, item] of Object.entries(value)) validateJson(item, `${label}.${key}`, seen);
}

export function cloneJson<T extends JsonValue>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
	) as T;
}

export function deepFreeze<T>(value: T): T {
	if (value instanceof AbortSignal || value instanceof Function) return value;
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) deepFreeze(item);
	}
	return value;
}

export function isEmptyJson(value: JsonValue): boolean {
	return (
		(Array.isArray(value) && value.length === 0) ||
		(value !== null &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			Object.keys(value).length === 0)
	);
}

export function digestJson(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
		.join(',')}}`;
}
