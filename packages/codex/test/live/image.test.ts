/**
 * An image from a tool of the seat on a real `codex`: a default seat calls a
 * tool that returns a red picture, and the model reads the color from it.
 */
import { deflateSync } from 'node:zlib';
import { defineTool } from '@ambionframework/ambion';
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import { errorsIn, live, open, person, saidBy, seat, untilQuiet } from './support.ts';

/** The CRC-32 of a buffer, as PNG chunks carry it. */
function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, and the CRC of the type and the data. */
function chunk(type: string, data: Buffer): Buffer {
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const head = Buffer.alloc(4);
	head.writeUInt32BE(data.length);
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc32(body));
	return Buffer.concat([head, body, tail]);
}

/** A solid RGB picture as a PNG. */
function solidPng(width: number, height: number, [red, green, blue]: readonly number[]): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([
		Buffer.from([0]),
		Buffer.from(Array(width).fill([red, green, blue]).flat()),
	]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

const RED = [255, 0, 0] as const;

const look = defineTool({
	name: 'look',
	description: 'Look at one picture. The result is the picture.',
	parameters: Type.Object({}),
	execute: () => ({
		content: [
			{ type: 'image', data: solidPng(64, 32, RED).toString('base64'), mimeType: 'image/png' },
		],
		details: {},
	}),
});

live('image from a tool', () => {
	it('reaches a default seat, and the seat names the color', async () => {
		const { room, events } = await open('image', {
			agents: [
				seat('viewer', {
					instructions: 'Call look to see the picture, then answer through one say.',
					tools: [look],
				}),
			],
		});
		try {
			const visit = await room.visit(person);
			await visit.send({ text: 'Call look, then say the color of the image in one word.' });
			await untilQuiet(room);

			const said = saidBy((await room.read()).messages, 'viewer');
			expect(said.map((message) => message.text.toLowerCase()).join(' ')).toContain('red');
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});
});
