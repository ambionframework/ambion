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

const headings = (text: string): string[] =>
	text
		.split('\n')
		.filter((line) => line.startsWith('## '))
		.map((line) => line.trim());

it('each second-level heading of docs/room.md has one owner page', async () => {
	const room = headings(await read('../../../docs/room.md'));
	const agent = headings(await read('../../../docs/agent.md'));
	expect(room.filter((heading) => agent.includes(heading))).toEqual([]);
});

it('the glossary names agent.md as the owner of Step while it lives there', async () => {
	const room = await read('../../../docs/room.md');
	const agent = await read('../../../docs/agent.md');
	const row = room.split('\n').find((line) => line.startsWith('| Step '));
	expect(agent).toContain('## Steps and the trace');
	expect(row).toContain('(agent.md)');
	expect(row).not.toContain('PENDING');
});
