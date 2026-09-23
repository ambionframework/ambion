import { defineAgent } from '@ambionframework/ambion';
import { traceJournals } from '@ambionframework/ambion/hosting';
import { memoryJournals } from '@ambionframework/journal';
import { pi } from '@ambionframework/pi';
import { describe, expect, it } from 'vitest';
import { configure, definitionOf, executionFor, runtimeFor } from '../src/configure.ts';
import { scripted } from './scripted.ts';

const agent = (name: string) =>
	defineAgent({
		name,
		identity: `${name} identity`,
		executor: pi({ instructions: `${name} instructions`, model: 'scripted/test' }),
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

	it('composes the configured stream and traces over supplied storage', async () => {
		const stream = scripted;
		configure({ agents: [agent('execution')], stream });
		const storage = memoryJournals();
		const services = executionFor({ storage });
		const journal = await services.traces.open('configured-execution');
		await journal.append({ step: 1 }, 0);
		const runtimeTraces = traceJournals(runtimeFor({ storage }).storage);

		expect(services.stream).toBe(stream);
		expect((await (await runtimeTraces.open('configured-execution')).read(0)).entries).toHaveLength(
			1,
		);
	});
});
