/**
 * One room, two executor families: a seat on Pi and a seat on the Claude
 * Agent SDK. Pi runs on a scripted stream, and Claude on the fake
 * executable. The record holds the say of each.
 */
import { defineAgent, isSpoken, startRoom } from '@ambionframework/ambion';
import { composeExecutions } from '@ambionframework/ambion/hosting';
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

it('runs a Pi seat and a Claude seat in one room, and the record holds both says', async () => {
	const scenario = { turns: [[{ sayUntilLanded: 'The pour is Saturday, says Claude.' }]] };
	const room = await startRoom({
		name: roomName('mixed'),
		agents: [pilot, sonnet],
		execution: composeExecutions({
			pi: piExecution({
				stream: scripted((_context, _agent, call) =>
					call === 1 ? speak('The pour is Saturday, says Pi.') : quiet(),
				),
			}),
			claude: claudeExecution({
				pathToClaudeCodeExecutable: executable,
				env: { ...process.env, AMBION_FAKE: JSON.stringify(scenario) },
			}),
		}),
	});
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
