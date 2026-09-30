import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

export const WIDTH = 1280;
export const HEIGHT = 720;
export const FRAME_BYTES = WIDTH * HEIGHT * 3;

export interface Frame {
	at: string;
	digest: string;
	rgb: Buffer;
	png: Buffer;
}

function chunk(kind: string, bytes: Buffer): Buffer {
	const type = Buffer.from(kind);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(bytes.length);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
	return Buffer.concat([size, type, bytes, checksum]);
}

/** Encode the exact RGB pixels as a PNG for the sensor API. */
export function frameFromRgb(rgb: Buffer, at = new Date().toISOString()): Frame {
	if (rgb.length !== FRAME_BYTES) throw new Error('The RGB frame has an invalid size.');
	const pixels = Buffer.from(rgb);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(WIDTH, 0);
	header.writeUInt32BE(HEIGHT, 4);
	header[8] = 8;
	header[9] = 2;
	const rows = Buffer.alloc(HEIGHT * (WIDTH * 3 + 1));
	for (let y = 0; y < HEIGHT; y++)
		pixels.copy(rows, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
	const png = Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(rows)),
		chunk('IEND', Buffer.alloc(0)),
	]);
	return { at, rgb: pixels, png, digest: createHash('sha256').update(png).digest('hex') };
}

/** Collect complete frames across arbitrary pipe boundaries. */
export class FrameDecoder {
	private pending = Buffer.alloc(0);
	push(bytes: Buffer): Buffer[] {
		this.pending = Buffer.concat([this.pending, bytes]);
		const frames: Buffer[] = [];
		while (this.pending.length >= FRAME_BYTES) {
			frames.push(this.pending.subarray(0, FRAME_BYTES));
			this.pending = this.pending.subarray(FRAME_BYTES);
		}
		return frames;
	}
}

export function demoFrame(): Frame {
	const rgb = Buffer.alloc(FRAME_BYTES);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const offset = (y * WIDTH + x) * 3;
			rgb[offset] = Math.floor((x * 255) / WIDTH);
			rgb[offset + 1] = Math.floor((y * 255) / HEIGHT);
			rgb[offset + 2] = 96;
		}
	}
	return frameFromRgb(rgb);
}
