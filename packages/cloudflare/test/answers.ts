/**
 * The scripted stream for the workerd tier: the product answers once per
 * activation, and every other seat stays quiet. The stream comes from the
 * core's `/testing` entry and routes on the seat.
 *
 * The `slow` seat waits before it answers. Its activation is then provably
 * in flight while a test takes the room object away, so the commit that
 * follows is served by the room that came back.
 */
import { byAgent, quiet, type Script, scripted, speak } from '@ambionframework/ambion/testing';

let answers = 0;

/** How long the `slow` seat thinks. Long enough for a test to take the room away. */
const SLOW_MS = 1_000;

/** A call after a tool result belongs to the same pass and stays quiet. */
const inPass = (context: Parameters<Script>[0]): boolean =>
	context.messages.some((message) => message.role === 'toolResult');

const product: Script = (context) => {
	if (inPass(context)) return quiet();
	answers += 1;
	return speak(answers === 1 ? 'The pour is Saturday.' : `Answer ${answers}.`);
};

const slow: Script = async (context) => {
	if (inPass(context)) return quiet();
	await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
	return speak('The slow answer stands.');
};

export const stream = scripted(byAgent({ product, slow }));
