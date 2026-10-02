/**
 * A seat in a process of its own, for the test that kills it. It runs the
 * first activation of the exchange on sessions on disk, and the process dies
 * with SIGKILL at the point the mode names. The parent then reopens the
 * session in a process that lives.
 *
 *   node crash-child.ts <dir> <request|tool|second>
 *
 * - `request`: the first provider request is in flight.
 * - `tool`: the first tool call is running.
 * - `second`: the tool result is in the session, and the second request is in flight.
 */
import { defineAgent, defineTool } from '@ambionframework/ambion';
import { callTool, quiet } from '@ambionframework/ambion/testing';
import { Type } from 'typebox';
import { createPiOpener } from '../../src/executor.ts';
import { pi, stubModel } from '../../src/index.ts';
import { diskSessions } from '../../src/sessions.ts';
import { scriptedStream } from '../../src/testing.ts';
import { stateOf } from './activation.ts';
import { TwoQuestions, viewOf } from './two-questions.ts';

const [dir, mode] = process.argv.slice(2);
if (dir === undefined || mode === undefined) throw new Error('usage: crash-child.ts <dir> <mode>');

const die = () => process.kill(process.pid, 'SIGKILL');

const book = defineTool({
	name: 'book',
	description: 'Book a day.',
	parameters: Type.Object({}),
	execute: () => {
		if (mode === 'tool') die();
		return 'booked';
	},
});

export const definition = defineAgent({
	name: 'product',
	identity: 'Product.',
	executor: pi({ instructions: 'Work.', model: 'scripted/product', tools: [book] }),
});

const opener = createPiOpener({
	definition,
	model: stubModel,
	stream: scriptedStream((_context, _agent, request) => {
		if (request === 1 && mode === 'request') die();
		if (request === 2 && mode === 'second') die();
		return request === 1 ? callTool('book', {}) : quiet();
	}),
	now: () => 0,
	sessions: diskSessions(dir),
});
const session = stateOf(opener, definition, {
	id: 'message:1:product:1',
	room: new TwoQuestions(),
});
await session.pass({ kind: 'view', view: await viewOf('message:1:product:1') });
// The mode names a point of the pass. A pass that ends is a failed test.
process.stdout.write('survived\n');
