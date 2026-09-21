/**
 * The wire between the room tools server and the host.
 *
 * Codex spawns the room tools server as a subprocess. The subprocess cannot
 * hold the room, so it asks the host for the tool list and sends each call
 * over a local socket. Every message is one line of JSON.
 */
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/** What an MCP tool hands back to the model. */
export interface Result {
	[key: string]: unknown;
	content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
	isError?: boolean;
}

/** One tool as the server lists it: its name, its description and its JSON Schema. */
export interface ToolSpec {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

/** What the server sends to the host. */
export type Request =
	| { readonly id: number; readonly kind: 'manifest' }
	| { readonly id: number; readonly kind: 'call'; readonly tool: string; readonly args: unknown };

/** What the host answers. */
export type Reply =
	| { readonly id: number; readonly tools: readonly ToolSpec[] }
	| { readonly id: number; readonly result: Result }
	| { readonly id: number; readonly error: string };

/** One message as the line that carries it. */
export function frame(message: Request | Reply): string {
	return `${JSON.stringify(message)}\n`;
}

/** Call `on` with each message that arrives as a line on `input`. A line that is not JSON is dropped. */
export function receive(input: Readable, on: (message: unknown) => void): void {
	createInterface({ input, crlfDelay: Infinity }).on('line', (line) => {
		try {
			on(JSON.parse(line));
		} catch {
			// A partial or foreign line carries no request.
		}
	});
}
