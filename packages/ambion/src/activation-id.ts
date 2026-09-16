/** The durable identity of one activation. */

import type { Seq } from './types.ts';

/** The journal fact that gives an activation its identity. */
export type ActivationSource = 'message' | 'opened' | 'closed';

/** The fields encoded in an activation id. */
export interface ActivationId {
	readonly source: ActivationSource;
	readonly position: Seq;
	readonly seat: string;
	readonly attempt: number;
}

const SOURCES: ReadonlySet<string> = new Set<ActivationSource>(['message', 'opened', 'closed']);
const SEAT = /^[a-z][a-z0-9-]*$/;
const ID = /^(message|opened|closed):([1-9]\d*):([a-z][a-z0-9-]*):([1-9]\d*)$/;

/** Encode one activation id in the durable format. */
export function encodeActivationId(value: ActivationId): string {
	if (!SOURCES.has(value.source)) throw new Error(`Unknown activation source '${value.source}'.`);
	if (!safePositiveInteger(value.position))
		throw new Error('Activation position must be positive.');
	if (typeof value.seat !== 'string' || SEAT.exec(value.seat)?.[0] !== value.seat)
		throw new Error(`Invalid activation seat '${value.seat}'.`);
	if (!safePositiveInteger(value.attempt)) throw new Error('Activation attempt must be positive.');
	return `${value.source}:${value.position}:${value.seat}:${value.attempt}`;
}

/** Decode a canonical durable activation id, or return undefined for malformed input. */
export function decodeActivationId(raw: unknown): ActivationId | undefined {
	if (typeof raw !== 'string') return undefined;
	const parts = ID.exec(raw);
	if (parts === null || parts[0] !== raw) return undefined;
	const position = positiveInteger(parts[2]);
	const attempt = positiveInteger(parts[4]);
	if (position === undefined || attempt === undefined) return undefined;
	const source = parts[1];
	const seat = parts[3];
	if (source === undefined || !SOURCES.has(source) || seat === undefined || !SEAT.test(seat))
		return undefined;
	return { source: source as ActivationSource, position, seat, attempt };
}

function positiveInteger(text: string | undefined): number | undefined {
	if (text === undefined) return undefined;
	const value = Number(text);
	return safePositiveInteger(value) && String(value) === text ? value : undefined;
}

function safePositiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}
