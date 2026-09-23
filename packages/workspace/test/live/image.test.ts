/**
 * A workspace picture reaches the model as an image, not as a description of
 * one. `docs/workspace.md` documents the `read` tool's image support; a
 * scripted stream cannot prove that a real provider accepts the image
 * content block the tool returns, or that a real model actually sees the
 * picture, rather than only being told a file exists.
 */

import { deflateSync } from 'node:zlib';
import { expect, it } from 'vitest';
import {
	agent,
	invariants,
	live,
	open,
	person,
	report,
	saidBy,
	spent,
} from '../../../ambion/test/live/support.ts';
import { enter, roomName } from '../../../ambion/test/support/room.ts';
import { memoryBackend } from '../../../just-bash/src/index.ts';
import { BACKGROUND_CONTEXT, openWorkspace } from '../../src/index.ts';

type Rgb = readonly [number, number, number];

/** The bytes one PNG chunk holds: its length, type, data and CRC. */
function chunk(type: string, data: Uint8Array): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeBytes = Buffer.from(type, 'ascii');
	const body = Buffer.concat([typeBytes, data]);
	const crcField = Buffer.alloc(4);
	crcField.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crcField]);
}

/** The CRC-32 PNG uses for every chunk, the same polynomial as zlib and gzip. */
function crc32(bytes: Uint8Array): number {
	let crc = ~0;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return ~crc >>> 0;
}

/**
 * A PNG of two solid-color horizontal bands, encoded with no image library:
 * raw 8-bit RGB scanlines, deflated, and the three chunks a decoder needs.
 */
function twoBandPng(size: number, top: Rgb, bottom: Rgb): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // one byte per channel
	header[9] = 2; // color type: RGB, no alpha
	const rowBytes = size * 3;
	const raw = Buffer.alloc((rowBytes + 1) * size);
	for (let y = 0; y < size; y += 1) {
		const color = y < size / 2 ? top : bottom;
		const row = y * (rowBytes + 1);
		raw[row] = 0; // filter: none
		for (let x = 0; x < size; x += 1) {
			const pixel = row + 1 + x * 3;
			raw[pixel] = color[0];
			raw[pixel + 1] = color[1];
			raw[pixel + 2] = color[2];
		}
	}
	return Buffer.concat([
		signature,
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', new Uint8Array(0)),
	]);
}

const MAGENTA: Rgb = [255, 0, 255];
const CYAN: Rgb = [0, 255, 255];

live('a workspace picture', () => {
	it('a seat reads an image file and describes what it actually shows', async () => {
		const backend = memoryBackend();
		const store = openWorkspace({ name: roomName('live-image'), backend: { bash: backend } });
		await store.use({ name: 'seed' }, async (env) => {
			await env.writeFile(
				'/home/curator/gallery/swatch.png',
				twoBandPng(64, MAGENTA, CYAN),
				BACKGROUND_CONTEXT,
			);
		});
		const curator = agent('curator', {
			identity: 'Keeps the gallery.',
			instructions: `
				Before you answer a question about the swatch, read
				gallery/swatch.png in your home directory with the read tool. Then
				answer with one say, in one sentence, naming the two colors you see
				and which one is on top.
			`,
			bundles: [store.tools()],
		});
		const { session, events } = await open('image', { agents: [curator] });
		const visit = await enter(session, person);
		const exchange = await visit.send({ text: 'What does the swatch look like?' });
		await exchange.waitForSummary();

		const tools = events.flatMap((e) =>
			e.type === 'tool_execution_start' && e.agent === 'curator' ? [e.toolName] : [],
		);
		expect(tools).toContain('read');
		const answer = saidBy((await session.read()).messages, 'curator');
		expect(answer.length).toBeGreaterThanOrEqual(1);
		const text = answer
			.map((m) => m.text)
			.join(' ')
			.toLowerCase();
		expect(text).toMatch(/magenta|pink|fuchsia|purple/);
		expect(text).toMatch(/cyan|turquoise|teal|aqua/);
		await invariants(session, events);
		report('a workspace picture', await spent(session));
		await session.stop();
		await store.dispose();
	});
});
