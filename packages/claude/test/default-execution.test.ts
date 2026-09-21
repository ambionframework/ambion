/**
 * The default executions of a mixed room. A room with a Pi seat and a Claude
 * seat and no `execution` routes each seat to the default of its family.
 * The Pi default proves itself in the Pi package. Here each kind registers
 * its execution over a scripted stream or the fake executable, because a
 * default takes no option that names either.
 */
import { defineAgent, isSpoken, startRoom } from '@ambionframework/ambion';
import { registerDefaultExecution } from '@ambionframework/ambion/hosting';
import { pi, piExecution } from '@ambionframework/pi';
import { expect, it } from 'vitest';
import { andrei, roomName } from '../../ambion/test/support/room.ts';
import { quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { claude, claudeExecution } from '../src/index.ts';
import { executable } from './support.ts';

const pilot = defineAgent({
	name: 'pilot',
	identity: 'Answers on Pi.',
	executor: pi({ instructions: 'Answer once.', model: 'scripted/pilot' }),
});

const sonnet = defineAgent({
	name: 'sonnet',
	identity: 'Answers on Claude.',
	executor: claude({ instructions: 'Answer once.', model: 'claude-fake' }),
});

it('routes a Pi seat and a Claude seat to the default of each family', async () => {
	registerDefaultExecution('pi', () =>
		piExecution({
			stream: scripted((_context, _agent, call) =>
				call === 1 ? speak('The pour is Saturday, says Pi.') : quiet(),
			),
		}),
	);
	const scenario = { turns: [[{ sayUntilLanded: 'The pour is Saturday, says Claude.' }]] };
	registerDefaultExecution('claude', () =>
		claudeExecution({
			pathToClaudeCodeExecutable: executable,
			env: { ...process.env, AMBION_FAKE: JSON.stringify(scenario) },
		}),
	);
	const room = await startRoom({ name: roomName('mixed-default'), agents: [pilot, sonnet] });
	try {
		const visit = await room.visit(andrei);
		const exchange = await visit.send({ text: 'When is the pour?' });
		const messages = await exchange.waitForClose();
		const said = messages.filter(isSpoken).map((message) => [message.from, message.text]);
		expect(said).toContainEqual(['pilot', 'The pour is Saturday, says Pi.']);
		expect(said).toContainEqual(['sonnet', 'The pour is Saturday, says Claude.']);
	} finally {
		await room.stop();
	}
});
