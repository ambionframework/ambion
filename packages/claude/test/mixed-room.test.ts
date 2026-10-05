/**
 * One room, two executor kinds: a seat on Pi and a seat on the Claude
 * Agent SDK. Pi runs on a scripted stream, and Claude on the fake
 * executable. The record holds the say of each, whether the room names its
 * execution or its runtime supplies one for each kind.
 */
import { createRuntime, defineAgent, isSaid, type Room, startRoom } from '@ambionframework/ambion';
import { memoryJournals } from '@ambionframework/journal';
import { piExecution } from '@ambionframework/pi';
import { expect, it } from 'vitest';
import { andrei, roomName, scriptedAgent } from '../../ambion/test/support/room.ts';
import { quiet, say, scriptedStream } from '../../ambion/test/support/scripted.ts';
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
			passes: [[{ sayUntilLanded: 'The pour is Saturday, says Claude.' }]],
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
	await expectBothSay(
		await startRoom({
			runtime: createRuntime({ storage: memoryJournals() }),
			name: roomName('mixed'),
			agents,
			execution,
		}),
	);
});

it('uses the supplied executions of the runtime even when other executions are built', async () => {
	const runtime = createRuntime({ storage: memoryJournals(), execution: [pilot(), sonnet()] });
	piExecution({
		sessions: 'memory',
		stream: scriptedStream(() => say('Leaked from another room.')),
	});
	claudeExecution({ pathToClaudeCodeExecutable: 'no-such-executable' });
	await expectBothSay(await startRoom({ name: roomName('mixed-runtime'), agents, runtime }));
});
