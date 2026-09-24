/**
 * One room, two executor families: a seat on Pi and a seat on the Claude
 * Agent SDK. Pi runs on a scripted stream, and Claude on the fake
 * executable. The record holds the say of each, whether the room names its
 * execution or routes each seat to the default of its family.
 */
import { defineAgent, isSpoken, type Room, startRoom } from '@ambionframework/ambion';
import { composeExecutions, registerDefaultExecution } from '@ambionframework/ambion/hosting';
import { piExecution } from '@ambionframework/pi';
import { expect, it } from 'vitest';
import { andrei, roomName, scriptedAgent } from '../../ambion/test/support/room.ts';
import { quiet, scripted, speak } from '../../ambion/test/support/scripted.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { claude, claudeExecution } from '../src/index.ts';
import { executable } from './support.ts';

const agents = [
	scriptedAgent('pilot', 'Answers on Pi.'),
	defineAgent({
		name: 'sonnet',
		identity: 'Answers on Claude.',
		executor: claude({ instructions: 'Answer once.', model: 'claude-fake' }),
	}),
];

const pilot = () =>
	piExecution({
		sessions: 'memory',
		stream: scripted((_context, _agent, call) =>
			call === 1 ? speak('The pour is Saturday, says Pi.') : quiet(),
		),
	});

const sonnet = () =>
	claudeExecution({
		pathToClaudeCodeExecutable: executable,
		env: {
			...process.env,
			AMBION_FAKE: JSON.stringify({
				turns: [[{ sayUntilLanded: 'The pour is Saturday, says Claude.' }]],
			}),
		},
	});

async function expectBothSay(room: Room): Promise<void> {
	stopAtEnd(room);
	const visit = await room.visit(andrei);
	const exchange = await visit.send({ text: 'When is the pour?' });
	const said = (await exchange.waitForClose())
		.filter(isSpoken)
		.map((message) => [message.from, message.text]);
	expect(said).toContainEqual(['pilot', 'The pour is Saturday, says Pi.']);
	expect(said).toContainEqual(['sonnet', 'The pour is Saturday, says Claude.']);
}

it('runs a Pi seat and a Claude seat in one room, and the record holds both says', async () => {
	const execution = composeExecutions({ pi: pilot(), claude: sonnet() });
	await expectBothSay(await startRoom({ name: roomName('mixed'), agents, execution }));
});

it('routes a Pi seat and a Claude seat to the default of each family', async () => {
	registerDefaultExecution('pi', pilot);
	registerDefaultExecution('claude', sonnet);
	await expectBothSay(await startRoom({ name: roomName('mixed-default'), agents }));
});
