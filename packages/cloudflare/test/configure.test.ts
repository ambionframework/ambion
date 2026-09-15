import { defineAgent } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { configure, definitionOf } from '../src/configure.ts';

const agent = (name: string) =>
	defineAgent({
		name,
		identity: `${name} identity`,
		instructions: `${name} instructions`,
		model: 'scripted/test',
	});

describe('configure', () => {
	it('captures the configured agent list', () => {
		const first = agent('first');
		const later = agent('later');
		const agents = [first];
		configure({ agents });
		agents.push(later);
		expect(definitionOf('first')).toBe(first);
		expect(() => definitionOf('later')).toThrow(/not configured/);
	});

	it('refuses duplicate configured names', () => {
		const first = agent('duplicate');
		const second = agent('duplicate');
		expect(() => configure({ agents: [first, second] })).toThrow(/repeat agent 'duplicate'/);
	});
});
