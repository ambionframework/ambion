/**
 * A real model calls `schedule` with `delaySeconds`, and the room returns the
 * say when it is due. The scripted tier proves the mechanism. Only a real
 * model shows that it reads the parameter name from the tool, fills it, and
 * wakes on the room's clock to finish the work.
 */
import { expect, it } from 'vitest';
import { isPosted, isSaid, type PostedMessage } from '../../src/index.ts';
import { enter, messagesOf } from '../support/room.ts';
import {
	agent,
	invariants,
	live,
	open,
	person,
	report,
	saidBy,
	spent,
	untilQuiet,
	within,
} from './support.ts';

/** The room takes a delay of one to thirty seconds, so the test returns fast. */
const LIMITS = { schedule: { minDelaySeconds: 1, maxDelaySeconds: 30 } };

/** How long the room may take to return the say, after the longest delay. */
const RETURN_MS = 90_000;

live('schedule', () => {
	it('a seat schedules a say with `delaySeconds`, and the room returns it when due', async () => {
		const follower = agent('follower', {
			identity: 'Follows up on work later, when a person asks it to.',
			instructions: `
				When somebody asks you to check back after some seconds, call schedule
				once. Set delaySeconds to the number of seconds they name. Set text to
				one sentence that tells you to check back. After schedule returns, end
				your turn and call no other tool.

				When the room wakes you with a scheduled message, call say once, to
				the person who asked, with one short sentence that says you checked
				back.
			`,
		});
		const { session, events } = await open('schedule', { agents: [follower] }, LIMITS);
		const visit = await enter(session, person);
		const returned = new Promise<PostedMessage>((resolve) => {
			session.subscribe((e) => {
				if (e.type === 'message' && isPosted(e.message) && e.message.returns !== undefined)
					resolve(e.message);
			});
		});
		await visit.send({ text: 'Please check back with me in about 5 seconds.' });
		await untilQuiet(session);

		// The first exchange closes while the say waits.
		const waiting = saidBy(await messagesOf(session), 'follower').filter(
			(m) => m.delaySeconds !== undefined,
		);
		const scheduled = waiting[0];
		expect(scheduled).toBeDefined();
		const delaySeconds = scheduled?.delaySeconds ?? 0;
		expect(Number.isInteger(delaySeconds)).toBe(true);
		expect(delaySeconds).toBeGreaterThanOrEqual(LIMITS.schedule.minDelaySeconds);
		expect(delaySeconds).toBeLessThanOrEqual(LIMITS.schedule.maxDelaySeconds);
		expect(scheduled?.to).toBe('follower');

		// The room returns the say once its due time passes, on its own clock.
		const post = await within(returned, RETURN_MS, 'the room returning the scheduled say');
		expect(post.returns).toBe(scheduled?.seq);
		expect(post.to).toBe('follower');
		const due = Date.parse(scheduled?.at ?? '') + delaySeconds * 1000;
		expect(Date.parse(post.at)).toBeGreaterThanOrEqual(due);

		// The seat answers the returned say, and the room goes quiet. The say no longer waits.
		await untilQuiet(session);
		const messages = await messagesOf(session);
		const answers = messages.filter(
			(m) => isSaid(m) && m.from === 'follower' && m.delaySeconds === undefined && m.seq > post.seq,
		);
		expect(answers.length).toBeGreaterThanOrEqual(1);
		const waits = (await session.read({ messages: false })).scheduled;
		expect(waits.map((say) => say.seq)).not.toContain(scheduled?.seq);
		await invariants(session, events);
		report('schedule', await spent(session));
		await session.stop();
	});
});
