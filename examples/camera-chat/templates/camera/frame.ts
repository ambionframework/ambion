import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { crc32, deflate, deflateSync } from 'node:zlib';

const deflateAsync = promisify(deflate);

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

/** Copy the RGB pixels and add the PNG filter byte before each row. */
function scanlines(rgb: Buffer): { pixels: Buffer; rows: Buffer } {
	if (rgb.length !== FRAME_BYTES) throw new Error('The RGB frame has an invalid size.');
	const pixels = Buffer.from(rgb);
	const rows = Buffer.alloc(HEIGHT * (WIDTH * 3 + 1));
	for (let y = 0; y < HEIGHT; y++)
		pixels.copy(rows, y * (WIDTH * 3 + 1) + 1, y * WIDTH * 3, (y + 1) * WIDTH * 3);
	return { pixels, rows };
}

function assemble(pixels: Buffer, compressed: Buffer, at: string): Frame {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(WIDTH, 0);
	header.writeUInt32BE(HEIGHT, 4);
	header[8] = 8;
	header[9] = 2;
	const png = Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', compressed),
		chunk('IEND', Buffer.alloc(0)),
	]);
	return { at, rgb: pixels, png, digest: createHash('sha256').update(png).digest('hex') };
}

/** Encode the exact RGB pixels as a PNG for the sensor API. */
function frameFromRgb(rgb: Buffer, at = new Date().toISOString()): Frame {
	const { pixels, rows } = scanlines(rgb);
	return assemble(pixels, deflateSync(rows), at);
}

/** Encode the exact RGB pixels as a PNG. Compress on the thread pool to keep HTTP reads responsive. */
export async function encodeFrame(rgb: Buffer, at: string): Promise<Frame> {
	const { pixels, rows } = scanlines(rgb);
	return assemble(pixels, await deflateAsync(rows), at);
}

/** Collect complete frames across arbitrary pipe boundaries. Copy each byte once. */
export class FrameDecoder {
	private chunks: Buffer[] = [];
	private size = 0;
	push(bytes: Buffer): Buffer[] {
		this.chunks.push(bytes);
		this.size += bytes.length;
		if (this.size < FRAME_BYTES) return [];
		let pending = Buffer.concat(this.chunks, this.size);
		const frames: Buffer[] = [];
		while (pending.length >= FRAME_BYTES) {
			frames.push(pending.subarray(0, FRAME_BYTES));
			pending = pending.subarray(FRAME_BYTES);
		}
		this.chunks = pending.length > 0 ? [pending] : [];
		this.size = pending.length;
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
