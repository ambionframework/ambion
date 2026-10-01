/**
 * The worker the workerd tier runs: it configures the definitions and the
 * scripted model call, and exports the two objects `wrangler.jsonc` binds.
 */
import { defineAgent } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import { configure, RoomObject, SeatObject } from '../src/index.ts';
import { scripted } from './scripted.ts';

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

export const checker = defineAgent({
	name: 'checker',
	identity: 'Checks the work later.',
	executor: pi({ instructions: 'Check later.', model: 'scripted/checker' }),
});

/** A seat with a token limit that names the estimator the worker registers. */
export const reader = defineAgent({
	name: 'reader',
	identity: 'Reads the recent record.',
	executor: pi({
		instructions: 'Read.',
		model: 'scripted/reader',
		activationTokenLimit: 40,
		estimateTokens: 'chars',
	}),
});

/** The configuration of the tier. A test that configures its own restores this one. */
export const configuration = {
	agents: [assistant, product, slow, checker, reader],
	stream: scripted,
	estimators: { chars: (text: string) => text.length },
	// Alarms fire on their own in workerd: a wake nobody takes is sent again this often,
	// and a scheduled say may return one second after it lands.
	limits: { delivery: { resend: 50 }, schedule: { minDelaySeconds: 1 } },
};

configure(configuration);

export { RoomObject, SeatObject };

export default {
	fetch: () =>
		new Response('The room is a Durable Object; nothing is served here.', { status: 404 }),
};
