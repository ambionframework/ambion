/**
 * The worker the workerd tier runs: it configures the definitions and the
 * scripted model call, and exports the two objects `wrangler.jsonc` binds.
 */
import { defineAgent, pi } from '@ambionframework/ambion';
import { configure, RoomObject, SeatObject } from '../src/index.ts';
import { stream } from './answers.ts';

export const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	executor: pi({ instructions: 'Answer what was asked, once.', model: 'scripted/assistant' }),
});

export const product = defineAgent({
	name: 'product',
	identity: 'The product.',
	executor: pi({ instructions: 'Answer what is asked.', model: 'scripted/product' }),
});

export const slow = defineAgent({
	name: 'slow',
	identity: 'Answers, but not at once.',
	executor: pi({ instructions: 'Answer what is asked.', model: 'scripted/slow' }),
});

configure({
	agents: [assistant, product, slow],
	stream,
	// Alarms fire on their own in workerd: a wake nobody takes is sent again this often.
	limits: { delivery: { resend: 50 } },
});

export { RoomObject, SeatObject };

export default {
	fetch: () =>
		new Response('The room is a Durable Object; nothing is served here.', { status: 404 }),
};
