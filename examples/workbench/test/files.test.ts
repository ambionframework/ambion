import { mkdtemp, rm, writeFile as writeLocalFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryBackend } from '@ambionframework/just-bash';
import { BACKGROUND_CONTEXT, openWorkspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { attachFile, isImagePath, readFile } from '../src/files.ts';

const scribe = { name: 'scribe' };

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The signature and the shortest valid `IHDR` header: enough for image detection to see a PNG. */
const FAKE_PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

describe('isImagePath', () => {
	it('recognizes the extensions the panel previews as a picture', () => {
		for (const path of ['/a.png', '/a.JPG', '/a.jpeg', '/a.gif', '/a.webp'])
			expect(isImagePath(path), path).toBe(true);
		for (const path of ['/notes.txt', '/lab.db']) expect(isImagePath(path), path).toBe(false);
	});
});

describe('readFile on a picture', () => {
	it('reads an image file as bytes, with its mime type and no text', async () => {
		const site = openWorkspace({ name: 'files-image', backend: { bash: memoryBackend() } });
		await site.use(scribe, (env) =>
			env.writeFile('/home/scribe/photo.png', FAKE_PNG, BACKGROUND_CONTEXT),
		);

		const file = await readFile(site, '/home/scribe/photo.png');

		expect(file.image).toEqual({ data: FAKE_PNG, mimeType: 'image/png' });
		expect(file.text).toBe('');
		expect(file.tables).toBeUndefined();
		await site.dispose();
	});

	it('refuses a picture past the preview size limit', async () => {
		const site = openWorkspace({ name: 'files-image-big', backend: { bash: memoryBackend() } });
		const big = new Uint8Array(8_388_609);
		big.set(FAKE_PNG);
		await site.use(scribe, (env) => env.writeFile('/home/scribe/big.png', big, BACKGROUND_CONTEXT));

		await expect(readFile(site, '/home/scribe/big.png')).rejects.toThrow(/8 MiB/);
		await site.dispose();
	});
});

describe('attachFile', () => {
	it('copies a real local file into the workspace, under /attachments', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-attach-'));
		directories.push(dir);
		const localPath = join(dir, 'board.png');
		await writeLocalFile(localPath, FAKE_PNG);
		const site = openWorkspace({ name: 'attach-real', backend: { bash: memoryBackend() } });

		const entry = await attachFile(site, localPath);

		expect(entry.path).toMatch(/^\/attachments\/\d+-board\.png$/);
		expect(entry.size).toBe(FAKE_PNG.length);
		const stored = await site.use(scribe, (env) =>
			env.readBinaryFile(entry.path, BACKGROUND_CONTEXT),
		);
		if (!stored.ok) throw new Error('The attached file is missing from the workspace.');
		expect(Array.from(stored.value)).toEqual(Array.from(FAKE_PNG));
		await site.dispose();
	});

	it('expands a ~/ path to the real home directory before reading it', async () => {
		const site = openWorkspace({ name: 'attach-tilde', backend: { bash: memoryBackend() } });
		const resolved = join(homedir(), 'no-such-picture.png');

		await expect(attachFile(site, '~/no-such-picture.png')).rejects.toThrow(
			new RegExp(resolved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
		);
		await site.dispose();
	});
});
