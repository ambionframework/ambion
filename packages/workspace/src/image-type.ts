/**
 * The image format of a file, from its first bytes. A format here is one that
 * a model accepts as an attachment, except BMP, which the `read` tool names
 * and does not attach. An animated PNG and a damaged header have no format.
 *
 * The code derives from the image detection of the agent harness of Pi
 * (earendil-works/pi, MIT License, Mario Zechner).
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The bits per pixel that a BMP header may name. */
const BMP_DEPTHS = [1, 4, 8, 16, 24, 32];

/** The MIME type of the image in `bytes`, or undefined when `bytes` holds no supported image. */
export function imageMimeType(bytes: Uint8Array): string | undefined {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return bytes[3] === 0xf7 ? undefined : 'image/jpeg';
	if (startsWith(bytes, PNG_SIGNATURE)) {
		return isPng(bytes) && !isAnimatedPng(bytes) ? 'image/png' : undefined;
	}
	return textSignatureType(bytes);
}

/** The image formats whose first bytes are ASCII text. */
function textSignatureType(bytes: Uint8Array): string | undefined {
	if (startsWithAscii(bytes, 0, 'GIF87a') || startsWithAscii(bytes, 0, 'GIF89a')) {
		return 'image/gif';
	}
	if (startsWithAscii(bytes, 0, 'RIFF') && startsWithAscii(bytes, 8, 'WEBP')) return 'image/webp';
	return startsWithAscii(bytes, 0, 'BM') && isBmp(bytes) ? 'image/bmp' : undefined;
}

function isPng(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 16 &&
		uint32BE(bytes, PNG_SIGNATURE.length) === 13 &&
		startsWithAscii(bytes, 12, 'IHDR')
	);
}

/** A PNG is animated when an `acTL` chunk comes before the first `IDAT` chunk. */
function isAnimatedPng(bytes: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= bytes.length) {
		if (startsWithAscii(bytes, offset + 4, 'acTL')) return true;
		if (startsWithAscii(bytes, offset + 4, 'IDAT')) return false;
		const next = offset + 8 + uint32BE(bytes, offset) + 4;
		if (next <= offset || next > bytes.length) return false;
		offset = next;
	}
	return false;
}

function isBmp(bytes: Uint8Array): boolean {
	if (bytes.length < 26) return false;
	const fileSize = uint32LE(bytes, 2);
	const pixelOffset = uint32LE(bytes, 10);
	const headerSize = uint32LE(bytes, 14);
	if (fileSize !== 0 && fileSize < 26) return false;
	if (pixelOffset < 14 + headerSize) return false;
	if (fileSize !== 0 && pixelOffset >= fileSize) return false;
	if (headerSize === 12) return planesAndDepth(bytes, 22);
	if (headerSize >= 40 && headerSize <= 124) return bytes.length >= 30 && planesAndDepth(bytes, 26);
	return false;
}

/** One color plane, and a bit depth that a BMP may have. */
function planesAndDepth(bytes: Uint8Array, offset: number): boolean {
	return uint16LE(bytes, offset) === 1 && BMP_DEPTHS.includes(uint16LE(bytes, offset + 2));
}

const uint16LE = (bytes: Uint8Array, offset: number): number =>
	(bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8);

const uint32BE = (bytes: Uint8Array, offset: number): number =>
	(bytes[offset] ?? 0) * 0x1000000 +
	((bytes[offset + 1] ?? 0) << 16) +
	((bytes[offset + 2] ?? 0) << 8) +
	(bytes[offset + 3] ?? 0);

const uint32LE = (bytes: Uint8Array, offset: number): number =>
	(bytes[offset] ?? 0) +
	((bytes[offset + 1] ?? 0) << 8) +
	((bytes[offset + 2] ?? 0) << 16) +
	(bytes[offset + 3] ?? 0) * 0x1000000;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
	return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
	if (bytes.length < offset + text.length) return false;
	return [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}
