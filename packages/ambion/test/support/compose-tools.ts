/**
 * Stand-in tools for the tests of `compose`: a declared table and total, a
 * tool that holds, a tool that counts the calls that run together, and a
 * tool that fails. Only tests import this file.
 */
import { Type } from 'typebox';
import type { ToolResult } from '../../src/bundle.ts';
import { defineTool } from '../../src/index.ts';

export const text = (value: string): ToolResult['content'] => [{ type: 'text', text: value }];
export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const echo = defineTool({
	name: 'echo',
	description: 'Return the text.',
	parameters: Type.Object({ text: Type.String() }),
	execute: ({ text: value }) => value,
});

const Rows = Type.Object({
	rows: Type.Array(Type.Object({ id: Type.Integer(), label: Type.String() })),
});

export const table = defineTool({
	name: 'table',
	description: 'Give a count of rows.',
	parameters: Type.Object({ count: Type.Integer() }),
	compose: { output: Rows },
	execute: ({ count }) => ({
		content: text(`${count} rows`),
		details: { rows: Array.from({ length: count }, (_, id) => ({ id, label: `row ${id}` })) },
	}),
});

export const total = defineTool({
	name: 'total',
	description: 'Add the ids.',
	parameters: Type.Object({ ids: Type.Array(Type.Integer()) }),
	compose: { output: Type.Object({ sum: Type.Integer() }) },
	execute: ({ ids }) => ({
		content: text('summed'),
		details: { sum: ids.reduce((sum, id) => sum + id, 0) },
	}),
});

/** The tool that records how many of its calls run together. */
export function gauge(name: string, executionMode?: 'sequential' | 'parallel') {
	const seen = { running: 0, most: 0, calls: 0 };
	const tool = defineTool({
		name,
		description: 'Hold for a moment.',
		parameters: Type.Object({}),
		...(executionMode === undefined ? {} : { executionMode }),
		execute: async () => {
			seen.calls += 1;
			seen.running += 1;
			seen.most = Math.max(seen.most, seen.running);
			await pause(5);
			seen.running -= 1;
			return 'held';
		},
	});
	return { tool, seen };
}

/** A tool that settles when the test opens its gate. */
export function held(name: string) {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	const seen = { calls: 0 };
	const tool = defineTool({
		name,
		description: 'Wait for the gate.',
		parameters: Type.Object({}),
		execute: async () => {
			seen.calls += 1;
			await opened;
			return 'released';
		},
	});
	return { tool, open, seen };
}

/** A tool that settles after a moment, so it outlives code that does not wait for it. */
export const later = (name: string, fails: boolean) =>
	defineTool({
		name,
		description: 'Settle after a moment.',
		parameters: Type.Object({}),
		execute: async () => {
			await pause(20);
			if (fails) throw new Error('Too late.');
			return 'late';
		},
	});

export const broken = defineTool({
	name: 'broken',
	description: 'Always fails.',
	parameters: Type.Object({}),
	execute: () => {
		throw Object.assign(new Error('The archive is closed.'), { details: { status: 3 } });
	},
});
