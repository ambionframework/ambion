/**
 * One room, two executor families: a Pi seat and a Codex seat. Both speak.
 * The file needs the Codex key and the key of the Pi model: `AMBION_MODEL`,
 * `anthropic/claude-sonnet-5` when unset.
 */
import { defineAgent } from '@ambionframework/ambion';
import { composeExecutions } from '@ambionframework/ambion/hosting';
import { pi, piExecution } from '@ambionframework/pi';
import { describe, expect, it } from 'vitest';
import { codexExecution } from '../../src/index.ts';
import { errorsIn, KEY_VAR, open, person, saidBy, seat, untilQuiet } from './support.ts';

const PI_MODEL = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
const PI_KEY = `${PI_MODEL.slice(0, PI_MODEL.indexOf('/')).toUpperCase().replace(/-/g, '_')}_API_KEY`;

describe.skipIf(!process.env[KEY_VAR] || !process.env[PI_KEY])('a mixed room', () => {
	it('lets a Pi seat and a Codex seat both speak', async () => {
		const pilot = defineAgent({
			name: 'pilot',
			identity: 'Answers on Pi.',
			executor: pi({ model: PI_MODEL, instructions: 'Answer through one say, in one sentence.' }),
		});
		const { room, events } = await open('mixed', {
			agents: [pilot, seat('gpt', { identity: 'Answers on Codex.' })],
			execution: composeExecutions({ pi: piExecution(), codex: codexExecution() }),
		});
		try {
			const visit = await room.visit(person);
			// One exchange for each seat, addressed to it, so that the two do not race.
			await visit.send({ to: 'pilot', text: 'Name the day that comes after Monday.' });
			await untilQuiet(room);
			await visit.send({ to: 'gpt', text: 'Name the day that comes after Friday.' });
			await untilQuiet(room);
			const messages = (await room.read()).messages;
			expect(saidBy(messages, 'pilot').length).toBeGreaterThanOrEqual(1);
			expect(saidBy(messages, 'gpt').length).toBeGreaterThanOrEqual(1);
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});
});
