/**
 * One room, two executor families on real models: a seat on Pi and a seat on
 * the Claude Agent SDK. Both speak, and the record invariants hold.
 */

import { expect, it } from 'vitest';
import { composeExecutions } from '../../../ambion/src/hosting.ts';
import { defineAgent, isSpoken } from '../../../ambion/src/index.ts';
import { invariants } from '../../../ambion/test/support/invariants.ts';
import { enter, messagesOf } from '../../../ambion/test/support/room.ts';
import { pi, piExecution } from '../../../pi/src/index.ts';
import { claude, claudeExecution } from '../../src/index.ts';
import { live, MODEL, open, person, untilQuiet } from './support.ts';

const holder = (fact: string) => `
	The one fact you hold: ${fact}
	When a question turns on it, state it once with one say, in one sentence.
`;

live('a mixed room', () => {
	it('a Pi seat and a Claude seat both speak, and the record holds', async () => {
		const pilot = defineAgent({
			name: 'pilot',
			identity: 'Concrete supplier desk.',
			executor: pi({
				model: `anthropic/${MODEL}`,
				instructions: holder('the concrete truck arrives on Saturday at 07:00.'),
			}),
		});
		const sonnet = defineAgent({
			name: 'sonnet',
			identity: 'Crane hire desk.',
			executor: claude({
				model: MODEL,
				instructions: holder('the crane is booked for Saturday from 08:00.'),
			}),
		});
		const { session, events } = await open(
			'mixed',
			[pilot, sonnet],
			composeExecutions({ pi: piExecution(), claude: claudeExecution() }),
		);
		try {
			const visit = await enter(session, person);
			await visit.send({
				text: 'What is booked for Saturday on site? I need the truck and the crane.',
			});
			await untilQuiet(session);
			const said = (await messagesOf(session)).filter(isSpoken);
			expect(said.filter((m) => m.from === 'pilot').length).toBeGreaterThanOrEqual(1);
			expect(said.filter((m) => m.from === 'sonnet').length).toBeGreaterThanOrEqual(1);
			await invariants(session, events);
		} finally {
			await session.stop();
		}
	});
});
