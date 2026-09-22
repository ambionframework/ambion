import { BACKGROUND_CONTEXT, memoryBackend, openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it } from 'vitest';
import { isImagePath, readFile } from '../src/files.ts';

const scribe = { name: 'scribe', identity: 'scribe identity' };

/** The signature and the shortest valid `IHDR` header: enough for image detection to see a PNG. */
const FAKE_PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

describe('isImagePath', () => {
	it('recognizes the extensions the panel previews as a picture', () => {
		expect(isImagePath('/photos/lab.png')).toBe(true);
		expect(isImagePath('/photos/lab.JPG')).toBe(true);
		expect(isImagePath('/photos/lab.jpeg')).toBe(true);
		expect(isImagePath('/photos/lab.gif')).toBe(true);
		expect(isImagePath('/photos/lab.webp')).toBe(true);
		expect(isImagePath('/notes.txt')).toBe(false);
		expect(isImagePath('/lab.db')).toBe(false);
	});
});

describe('readFile on a picture', () => {
	it('reads an image file as bytes, with its mime type and no text', async () => {
		const site = openWorkspace({ name: 'files-image', backend: memoryBackend() });
		await site.use(scribe, (env) =>
			env.writeFile('/home/scribe/photo.png', FAKE_PNG, BACKGROUND_CONTEXT),
		);

		const file = await readFile(site, '/home/scribe/photo.png');

		expect(file.image).toEqual({ data: FAKE_PNG, mimeType: 'image/png' });
		expect(file.text).toBe('');
		expect(file.tables).toBeUndefined();
		await site.destroy();
	});

	it('refuses a picture past the preview size limit', async () => {
		const site = openWorkspace({ name: 'files-image-big', backend: memoryBackend() });
		const big = new Uint8Array(8_388_609);
		big.set(FAKE_PNG);
		await site.use(scribe, (env) => env.writeFile('/home/scribe/big.png', big, BACKGROUND_CONTEXT));

		await expect(readFile(site, '/home/scribe/big.png')).rejects.toThrow(/8 MiB/);
		await site.destroy();
	});
});
