import { defineAgent, pi } from '@ambionframework/ambion';
import { memoryJournals } from '@ambionframework/journal';
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

	it('composes the configured stream and transcripts over supplied storage', async () => {
		const stream = scripted;
		configure({ agents: [agent('execution')], stream });
		const storage = memoryJournals();
		const services = executionFor({ storage });
		const id = 'configured-execution';
		const transcript = await services.transcripts.open(id, 'room');
		const runtimeTranscript = await runtimeFor({ storage }).transcripts.open(id);

		expect(services.stream).toBe(stream);
		expect(await transcript.getMetadata()).toMatchObject({ id, parentSessionId: 'room' });
		expect(await runtimeTranscript.getMetadata()).toMatchObject({ id, parentSessionId: 'room' });
	});
});
