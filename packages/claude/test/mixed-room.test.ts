/**
 * One room, two executor kinds: a seat on Pi and a seat on the Claude
 * Agent SDK. Pi runs on a scripted stream, and Claude on the fake
 * executable. The record holds the say of each, whether the room names its
 * execution or routes each seat to the default of its kind.
 */
import { defineAgent, isSaid, type Room, startRoom } from '@ambionframework/ambion';
import { defineExecution } from '@ambionframework/ambion/hosting';
import { createExecutionServices, piExecution } from '@ambionframework/pi';
import { expect, it } from 'vitest';
import { andrei, roomName, scriptedAgent } from '../../ambion/test/support/room.ts';
import { quiet, say, scriptedStream } from '../../ambion/test/support/scripted.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { createPiExecutor } from '../../pi/src/executor.ts';
import { createClaudeExecutor } from '../src/executor.ts';
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

const pilotStream = () =>
	scriptedStream((_context, _agent, request) =>
		request === 1 ? say('The pour is Saturday, says Pi.') : quiet(),
	);

const pilot = () => piExecution({ sessions: 'memory', stream: pilotStream() });

const sonnetOptions = () => ({
	pathToClaudeCodeExecutable: executable,
	env: {
		...process.env,
		AMBION_FAKE: JSON.stringify({
			turns: [[{ sayUntilLanded: 'The pour is Saturday, says Claude.' }]],
		}),
	},
});

const sonnet = () => claudeExecution(sonnetOptions());

async function expectBothSay(room: Room): Promise<void> {
	stopAtEnd(room);
	const visit = await room.visit(andrei);
	const exchange = await visit.send({ text: 'When is the pour?' });
	const said = (await exchange.waitForClose())
		.filter(isSaid)
		.map((message) => [message.from, message.text]);
	expect(said).toContainEqual(['pilot', 'The pour is Saturday, says Pi.']);
	expect(said).toContainEqual(['sonnet', 'The pour is Saturday, says Claude.']);
}

it('runs a Pi seat and a Claude seat in one room, and the record holds both says', async () => {
	const execution = [pilot(), sonnet()];
	await expectBothSay(await startRoom({ name: roomName('mixed'), agents, execution }));
});

it('routes a Pi seat and a Claude seat to the default of each kind, which a built execution keeps', async () => {
	// A definition of an execution makes it the default of its kind.
	defineExecution('pi', (host) => {
		const services = createExecutionServices({ sessions: 'memory', stream: pilotStream() });
		return (request) =>
			createPiExecutor({
				...services,
				definition: request.definition,
				now: () => host.clock.now(),
			});
	});
	defineExecution(
		'claude',
		() => (request) => createClaudeExecutor({ definition: request.definition, ...sonnetOptions() }),
	);
	// An execution that a host builds for one room does not change the default.
	piExecution({
		sessions: 'memory',
		stream: scriptedStream(() => say('Leaked from another room.')),
	});
	claudeExecution({ pathToClaudeCodeExecutable: 'no-such-executable' });
	await expectBothSay(await startRoom({ name: roomName('mixed-default'), agents }));
});
