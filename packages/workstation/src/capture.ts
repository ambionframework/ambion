/**
 * The output of one command, held within a bound as it arrives.
 *
 * A command can write far more than any view shows, and the whole output
 * would sit in the memory of the Ambion host. `Capture` keeps a window twice
 * the size of `maxBytes` on the side the view retains, and it counts the
 * bytes and lines of the whole output. It trims the window when the window
 * grows past twice its size, as Pi's `OutputCapture` does. The spill file
 * on the server holds the whole output.
 *
 * With no `maxBytes`, the window is `NO_LIMIT_WINDOW_BYTES`. An output past
 * twice that size loses its middle, and the view reports it as truncated.
 */

import { boundedView } from '@ambionframework/workspace';
import type { ShellOutputLimits, ShellOutputView } from '@earendil-works/pi-agent-core';

/** The window for a caller that names no byte limit. */
const NO_LIMIT_WINDOW_BYTES = 8 * 1024 * 1024;

/** The last `bytes` bytes of `text`, starting on a whole character. */
function lastBytes(text: string, bytes: number): string {
	const buffer = Buffer.from(text, 'utf8');
	let start = Math.max(0, buffer.length - bytes);
	while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return buffer.subarray(start).toString('utf8');
}

/** The first `bytes` bytes of `text`, ending on a whole character. */
function firstBytes(text: string, bytes: number): string {
	const buffer = Buffer.from(text, 'utf8');
	let end = Math.min(bytes, buffer.length);
	while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
	return buffer.subarray(0, end).toString('utf8');
}

function countNewlines(text: string): number {
	let count = 0;
	for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count += 1;
	return count;
}

export class Capture {
	private readonly decoder = new TextDecoder();
	private readonly window: number;
	private readonly maxLines: number;
	private buffer = '';
	private bufferBytes = 0;
	private totalBytes = 0;
	private newlines = 0;
	private endsWithNewline = true;
	private trimmed = false;

	constructor(private readonly limits: ShellOutputLimits | undefined) {
		const maxBytes = limits?.maxBytes ?? Number.POSITIVE_INFINITY;
		this.maxLines = limits?.maxLines ?? Number.POSITIVE_INFINITY;
		this.window = Number.isFinite(maxBytes) ? maxBytes * 2 : NO_LIMIT_WINDOW_BYTES;
	}

	/** Add one chunk of the byte stream. A character split across two chunks decodes whole. */
	push(chunk: Uint8Array): void {
		this.append(this.decoder.decode(chunk, { stream: true }));
	}

	/** Add text after the byte stream ends. */
	pushText(text: string): void {
		this.finish();
		this.append(text);
	}

	finish(): void {
		this.append(this.decoder.decode());
	}

	private append(text: string): void {
		if (text === '') return;
		const bytes = Buffer.byteLength(text, 'utf8');
		this.totalBytes += bytes;
		this.newlines += countNewlines(text);
		this.endsWithNewline = text.endsWith('\n');
		this.buffer += text;
		this.bufferBytes += bytes;
		if (this.bufferBytes <= this.window * 2) return;
		this.buffer =
			this.limits?.retain === 'head'
				? firstBytes(this.buffer, this.window)
				: lastBytes(this.buffer, this.window);
		this.bufferBytes = Buffer.byteLength(this.buffer, 'utf8');
		this.trimmed = true;
	}

	/** The bounded view. After a trim, the totals come from the counts of the whole output. */
	view(): ShellOutputView {
		const view = boundedView(this.buffer, this.limits);
		if (!this.trimmed) return view;
		const totalLines = this.newlines + (this.endsWithNewline ? 0 : 1);
		return {
			text: view.text,
			truncation: {
				...view.truncation,
				truncated: true,
				truncatedBy: totalLines > this.maxLines ? 'lines' : 'bytes',
				totalBytes: this.totalBytes,
				totalLines,
			},
		};
	}
}
