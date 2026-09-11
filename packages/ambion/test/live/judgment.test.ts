/**
 * Silence is the default, and a directed say focuses the room. Rules 3, 4
 * and 6 of `docs/agent.md`: the runtime states the bar and leaves the
 * decision to the agent. A scripted stream decides by script; only a real
 * model decides by the prompt.
 */
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import { defineTool, passive, stopSession } from '../../src/internal.ts';
import { enter } from '../support/room.ts';
import {
	activationsOf,
	agent,
	invariants,
	live,
	open,
	person,
	report,
	saidBy,
	saidByAgents,
	spent,
	untilQuiet,
} from './support.ts';

live('judgment', () => {
	it('a seat with nothing to add declines, and leaves no mark', async () => {
		const weather = agent('weather', {
			identity: 'Site weather desk.',
			instructions: `
				The forecast for today is 21°C and dry, with no rain. When somebody
				asks about the weather, answer with one say, in one sentence.
			`,
		});
		const payroll = agent('payroll', {
			identity: 'Payroll desk. Answers questions about pay and timesheets only.',
			instructions: `
				You answer questions about pay and timesheets. For any other
				question, end your turn without calling say.
			`,
		});
		const { session, repo, events } = open('declines', { agents: [weather, payroll] });
		const visit = await enter(session, person);
		await visit.deliver({ text: 'Will it rain on site today?' });
		await untilQuiet(session);

		const messages = await session.messages();
		const answers = saidBy(messages, 'weather');
		expect(answers).toHaveLength(1);
		expect(answers[0]?.text).toMatch(/dry|no rain/i);
		// The delivery woke payroll too: a glance, and no mark.
		expect(activationsOf(events, 'payroll')).toBeGreaterThanOrEqual(1);
		expect(saidBy(messages, 'payroll')).toEqual([]);
		expect(saidByAgents(messages, [person.name])).toHaveLength(1);
		await invariants(session, events);
		report('declining', await spent(repo, session.name));
		await stopSession(session);
	});

	it('a directed say wakes a seat at `named`, and the delivery never did', async () => {
		const stockLevel = defineTool({
			name: 'stock_level',
			description: 'The units in stock for one SKU.',
			parameters: Type.Object({ sku: Type.String() }),
			execute: async ({ sku }) => `${sku}: 42 units in stock.`,
		});
		const stock = agent('stock', {
			identity: 'Stock desk. Holds the inventory counts.',
			instructions: `
				When a colleague asks about a SKU, call stock_level with it, then
				answer with one say addressed to that colleague: set \`to\` to their
				name. Quote the count.
			`,
			tools: [stockLevel],
		});
		const desk = agent('desk', {
			identity: 'Front desk. Routes questions to the colleague who holds the answer.',
			instructions: `
				You hold no inventory. When somebody asks how many units of a SKU
				are in stock, ask the colleague named stock with one directed say:
				set \`to\` to "stock" and quote the SKU. Do nothing else. Once stock
				has answered, end your turn without calling say.
			`,
		});
		const { session, repo, events } = open('directed', { agents: [desk, passive(stock)] });
		const visit = await enter(session, person);
		await visit.deliver({ text: 'How many units of SKU A-100 do we have?' });
		await untilQuiet(session);

		const messages = await session.messages();
		const ask = saidBy(messages, 'desk').find((m) => m.to === 'stock');
		expect(ask).toBeDefined();
		// Nothing woke the passive seat until the say that named it.
		const asked = events.findIndex((e) => e.type === 'message' && e.message.seq === ask?.seq);
		const woken = events.findIndex((e) => e.type === 'activation_start' && e.agent === 'stock');
		expect(woken).toBeGreaterThan(asked);
		expect(activationsOf(events.slice(0, asked), 'stock')).toBe(0);
		expect(events).toContainEqual({
			type: 'tool_execution_start',
			agent: 'stock',
			toolName: 'stock_level',
		});
		const answer = saidBy(messages, 'stock');
		expect(answer).toHaveLength(1);
		expect(answer[0]?.text).toContain('42');
		await invariants(session, events);
		report('a directed say', await spent(repo, session.name));
		await stopSession(session);
	});
});
