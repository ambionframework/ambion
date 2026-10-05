import { defineAgent, startRoom } from '@ambionframework/ambion';
import { memoryJournals } from '@ambionframework/journal';
import { pi } from '@ambionframework/pi';
import { describe, expect, it } from 'vitest';
import { configure, definitionOf, runtimeFor, seatExecution, seatHost } from '../src/configure.ts';
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

	it('accepts an agent with the compose and describe tools', () => {
		const composer = defineAgent({
			name: 'composer',
			identity: 'composer identity',
			executor: pi({ instructions: 'Compose.', model: 'scripted/test' }),
		});
		expect(composer.executor.tools.map((tool) => tool.name)).toEqual(['compose', 'describe']);
		expect(() => configure({ agents: [composer] })).not.toThrow();
	});

	it('gives a seat the Pi execution, and a host with the configured limits and logger', () => {
		const logger = () => {};
		configure({
			agents: [agent('execution')],
			stream: scripted,
			logger,
			limits: { call: { attempts: 5 } },
		});
		expect(seatExecution().kind).toBe('pi');
		expect(seatHost().logger).toBe(logger);
		expect(seatHost().limits.call).toMatchObject({ attempts: 5 });
		configure({ agents: [agent('execution')] });
		expect(seatHost().logger).toBeUndefined();
		expect(seatHost().limits.call).toMatchObject({ attempts: 2 });
	});

	it('gives the runtime of an object the configured estimators', async () => {
		const reader = defineAgent({
			name: 'reader',
			identity: 'reader identity',
			executor: pi({
				instructions: 'Read.',
				model: 'scripted/test',
				activationTokenLimit: 40,
				estimateTokens: 'chars',
			}),
		});
		configure({ agents: [reader], estimators: { chars: (text: string) => text.length } });
		const room = await startRoom({
			name: 'estimators',
			runtime: runtimeFor({ storage: memoryJournals() }),
			agents: [reader],
		});
		await room.stop();
		configure({ agents: [reader] });
		await expect(
			startRoom({
				name: 'estimators',
				runtime: runtimeFor({ storage: memoryJournals() }),
				agents: [reader],
			}),
		).rejects.toThrow(
			"Agent 'reader' names estimator 'chars', and the runtime holds none by that name.",
		);
	});
});
