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

const headings = (text: string): string[] =>
	text
		.split('\n')
		.filter((line) => line.startsWith('## '))
		.map((line) => line.trim());

it('keeps documentation ownership and the Step glossary consistent', async () => {
	const [readme, room, agent, executors] = await Promise.all([
		read('../../../README.md'),
		read('../../../docs/room.md'),
		read('../../../docs/agent.md'),
		read('../../../docs/executors.md'),
	]);
	const positioning = new Set(sentences(readme));
	expect(sentences(room).filter((sentence) => positioning.has(sentence))).toEqual([]);
	const agentHeadings = headings(agent);
	expect(headings(room).filter((heading) => agentHeadings.includes(heading))).toEqual([]);
	const row = room.split('\n').find((line) => line.startsWith('| Step '));
	expect(executors).toContain('## The step vocabulary');
	expect(agent).not.toContain('## Steps and the trace');
	expect(row).toContain('(executors.md)');
	expect(row).not.toContain('PENDING');
});
