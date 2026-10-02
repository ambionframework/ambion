/**
 * The tools a thread keeps, and the ranges its inputs carry.
 *
 * Codex writes the dynamic tools of a thread to the first line of its
 * rollout file, in `session_meta.payload.dynamic_tools`. A thread that
 * resumes in a new process keeps those tools. The seat binds the tools of
 * each activation, and they change when the room changes: a new bundle, or
 * another seat set. The activation resumes a thread only when the tools it
 * keeps are the tools this activation binds.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ReadRange } from '@ambionframework/ambion/hosting';
import type { DynamicToolSpec } from './protocol.ts';

/** The first line of a file, or nothing when the file is empty or unreadable. */
async function firstLine(path: string): Promise<string | undefined> {
	const input = createReadStream(path, { encoding: 'utf8' });
	const lines = createInterface({ input, crlfDelay: Infinity });
	try {
		for await (const line of lines) return line;
		return undefined;
	} catch {
		return undefined;
	} finally {
		lines.close();
		input.destroy();
	}
}

/** The dynamic tools that a rollout file holds, or nothing when the file does not say. */
export async function keptTools(path: string): Promise<readonly unknown[] | undefined> {
	const line = await firstLine(path);
	if (line === undefined) return undefined;
	try {
		const first = JSON.parse(line) as {
			type?: string;
			payload?: { dynamic_tools?: readonly unknown[] | null };
		};
		if (first.type !== 'session_meta') return undefined;
		return first.payload?.dynamic_tools ?? [];
	} catch {
		return undefined;
	}
}

/** A value as text, with the keys of every object in order. Two equal values give one text. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
	const entries = Object.entries(value).sort(([one], [two]) => (one < two ? -1 : 1));
	return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
}

/** Whether the tools a thread keeps are the tools of this activation, by name, description, and schema. */
export function sameTools(kept: readonly unknown[], bound: readonly DynamicToolSpec[]): boolean {
	const texts = (tools: readonly unknown[]) => tools.map(canonical).sort();
	const one = texts(kept);
	const two = texts(bound);
	return one.length === two.length && one.every((text, at) => text === two[at]);
}

/** The ranges of the inputs that a pass waits to echo, by the id the input carries. */
export class Echoes {
	private readonly sent = new Map<string, ReadRange>();

	expect(id: string, range: ReadRange): void {
		this.sent.set(id, range);
	}

	/** The range of the input this echo confirms, once. An echo of another input gives nothing. */
	confirm(id: string | null): ReadRange | undefined {
		if (id === null) return undefined;
		const found = this.sent.get(id);
		this.sent.delete(id);
		return found;
	}

	/** Forget an input that the server refused. Its range stays unread. */
	forget(id: string): void {
		this.sent.delete(id);
	}
}
