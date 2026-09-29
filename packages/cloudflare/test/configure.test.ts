import { defineAgent, startRoom } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import { describe, expect, it } from 'vitest';
import {
	configure,
	definitionOf,
	executionFor,
	runtimeFor,
	traceLogger,
} from '../src/configure.ts';
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

	it('composes the configured stream and logger', () => {
		const stream = scripted;
		const logger = () => {};
		configure({ agents: [agent('execution')], stream, logger });
		expect(executionFor({}).stream).toBe(stream);
		expect(traceLogger()).toBe(logger);
		configure({ agents: [agent('execution')] });
		expect(traceLogger()).toBeUndefined();
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
		const room = await startRoom({ name: 'estimators', runtime: runtimeFor({}), agents: [reader] });
		await room.stop();
		configure({ agents: [reader] });
		await expect(
			startRoom({ name: 'estimators', runtime: runtimeFor({}), agents: [reader] }),
		).rejects.toThrow(
			"Agent 'reader' names estimator 'chars', and the runtime holds none by that name.",
		);
	});
});
