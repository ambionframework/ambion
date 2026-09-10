/**
 * The model, the key and the loop. `docs/agent.md` §1: without a `streamFn`,
 * a model resolves as `provider/model-id` from Pi's catalog and the key comes
 * from the environment. Nothing scripted touches that path.
 */
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import { defineTool, stopSession } from '../../src/index.ts';
import { enter } from '../support/room.ts';
import {
	agent,
	errorsIn,
	invariants,
	KEY_VAR,
	live,
	open,
	person,
	report,
	saidBy,
	spent,
	untilQuiet,
	within,
} from './support.ts';

const orders = defineTool({
	name: 'lookup_order',
	description: 'Fetch an order by id.',
	parameters: Type.Object({ id: Type.String({ description: 'The order id, digits only.' }) }),
	execute: async ({ id }) => `Order ${id}: shipped on 2 September, tracking code ZK-4410.`,
});

const clerk = () =>
	agent('clerk', {
		identity: 'Order desk. Looks orders up.',
		instructions: `
			When somebody asks about an order, call lookup_order with its id, then
			report the result with one say, in one sentence. Quote the tracking
			code exactly as the tool returned it.
		`,
		tools: [orders],
	});

live('the model and the loop', () => {
	it('resolves the model from its id, runs a tool through Pi, and stamps the say', async () => {
		const { session, repo, events } = open('loop', { agents: [clerk()] });
		const visit = await enter(session, person);
		await visit.deliver({ text: 'What is the status of order 7781?' });
		await untilQuiet(session);

		const messages = await session.messages();
		expect(events).toContainEqual({
			type: 'tool_execution_start',
			agent: 'clerk',
			toolName: 'lookup_order',
		});
		const said = saidBy(messages, 'clerk');
		expect(said).toHaveLength(1);
		expect(said[0]?.text).toContain('ZK-4410');
		expect(events).toContainEqual({ type: 'activation_end', agent: 'clerk', spoke: true });
		await invariants(session, events);

		// The seat's downstream session holds the turns, with the provider's usage on them.
		const total = await spent(repo, session.name);
		expect(total.activations).toBeGreaterThanOrEqual(1);
		expect(total.tokens).toBeGreaterThan(0);
		expect(total.cost).toBeGreaterThan(0);
		report('the loop', total);
		await stopSession(session);
	});

	it('a refused model call reaches the host as an error and leaves no mark', async () => {
		const key = process.env[KEY_VAR];
		process.env[KEY_VAR] = 'not-a-key';
		try {
			const { session, events } = open('refused', { agents: [clerk()] });
			const visit = await enter(session, person);
			const ended = new Promise<void>((resolve) => {
				session.subscribe((e) => {
					if (e.type === 'activation_end') resolve();
				});
			});
			await visit.deliver({ text: 'What is the status of order 7781?' });
			await within(ended, 60_000, 'the activation ending');
			// the failed activation is one attempt, and the room would wake the seat
			// again after the backoff: the abort writes that wake off
			session.abort();
			await within(session.settled(), 60_000, 'the room settling');

			const errors = errorsIn(events);
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatch(/^clerk: /);
			expect(saidBy(await session.messages(), 'clerk')).toEqual([]);
			expect(events).toContainEqual({ type: 'activation_end', agent: 'clerk', spoke: false });
			await stopSession(session);
		} finally {
			process.env[KEY_VAR] = key;
		}
	});
});
