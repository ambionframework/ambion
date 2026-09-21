import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const trust = resolve(here, '../../../docs/trust.md');
const page = readFileSync(trust, 'utf8');

const rowEvidence = (label: string): string[] => {
	const row = page.split('\n').find((line) => line.startsWith(`| ${label}`));
	if (row === undefined) throw new Error(`no row: ${label}`);
	return [...row.matchAll(/\]\((\.\.\/[^)]+\.test\.ts)\)/g)].map((m) => m[1] ?? '');
};

describe('docs/trust.md evidence', () => {
	it('links only to files that exist', () => {
		const links = [...page.matchAll(/\]\((\.[^)#]+)/g)].map((m) => m[1] ?? '');
		expect(links.length).toBeGreaterThan(0);
		for (const link of links) expect(existsSync(resolve(dirname(trust), link)), link).toBe(true);
	});

	it('cites tests that refuse a human name or an unknown name', () => {
		const files = rowEvidence('Seat a human name or an unknown name');
		const text = files.map((f) => readFileSync(resolve(dirname(trust), f), 'utf8')).join('\n');
		expect(text).toContain("seat('missing')");
		expect(text).toContain('a name the record knows as a person');
	});
});
