import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const read = (path: string): Promise<string> =>
	readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const sentences = (text: string): string[] =>
	text
		.replace(/\s+/g, ' ')
		.split(/(?<=[.!?])\s/)
		.map((sentence) => sentence.replace(/[*_`]/g, '').trim())
		.filter((sentence) => sentence.split(' ').length > 5);

it('docs/room.md does not restate the positioning of the README', async () => {
	const readme = new Set(sentences(await read('../../../README.md')));
	const room = sentences(await read('../../../docs/room.md'));
	const copied = room.filter((sentence) => readme.has(sentence));
	expect(copied).toEqual([]);
});
