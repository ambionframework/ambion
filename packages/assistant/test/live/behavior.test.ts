/**
 * The default assistant, driven by the simulator. A live assistant sits
 * beside the `inventory` specialist, whose evidence the test fixes, and a
 * person asks. Checks in code decide the exact facts, and a judge grades
 * the meaning that no regex can decide. See docs/simulator.md, Validation.
 *
 * `it.each` over k samples measures pass^k: a case passes when every
 * sample passes.
 */
import {
	agentActor,
	agentJudge,
	type Judge,
	type Run,
	scriptedActor,
	simulate,
} from '@ambionframework/simulator';
import { expect, it } from 'vitest';
import {
	answers,
	EXCHANGE_MS,
	JUDGE_MODEL,
	JUDGE_THINKING,
	live,
	MODEL,
	openRoom,
	presence,
	priya,
	saidBy,
	THINKING,
	track,
} from './support.ts';

const judge: Judge = (run, criteria) =>
	agentJudge({ model: JUDGE_MODEL, thinking: JUDGE_THINKING })(run, criteria);

const STOCK = 'The warehouse has 8 units of SKU A available to dispatch today.';
const EIGHT = /\b8\b|\beight\b/i;
const FIVE = /\b5\b|\bfive\b/i;
const SKU_B = /SKU\s*B\b/i;

/** Real milliseconds for a case of two exchanges and a grade. */
const TWO_EXCHANGES_MS = 420_000;
/** Real milliseconds for a case of three exchanges, three moves of the actor, and a grade. */
const THREE_EXCHANGES_MS = 600_000;

/** A run that the judge can grade: it ended cleanly, and each exchange has its summary. */
function expectGradable(run: Run, ended: readonly Run['ended'][] = ['limit']): void {
	expect(ended, run.error).toContain(run.ended);
	for (const exchange of run.exchanges) {
		expect(exchange.summary, JSON.stringify(exchange.discussion)).toBeDefined();
	}
}

live('the default assistant, driven by the simulator', () => {
	it.each([
		['broadcast', 1],
		['named', 1],
		['named', 2],
		['named', 3],
		[undefined, 1],
	] as const)(
		'routes %s participation without a restated prompt (sample %i)',
		async (attention, sample) => {
			const name = `routes-${attention ?? 'reserve'}-${sample}`;
			const evidence = track(name);
			const room = await openRoom({ specialist: answers(() => STOCK), attention });
			const run = await simulate(room, {
				person: priya,
				actor: scriptedActor([
					'How many units of SKU A can the warehouse dispatch today? Use current stock evidence.',
				]),
				exchanges: 1,
				exchangeMs: EXCHANGE_MS,
			});
			evidence.run = run;
			const [exchange] = run.exchanges;
			expectGradable(run);
			expect(saidBy(exchange, 'inventory')).not.toEqual([]);
			const speech = saidBy(exchange, 'assistant');
			if (attention === 'named') {
				expect(speech, JSON.stringify(speech)).toHaveLength(1);
				expect(speech[0]).toMatchObject({ to: 'inventory' });
			} else {
				expect(speech).toEqual([]);
			}
			if (attention === undefined) {
				// The specialist starts in the reserve, and the assistant seats it.
				expect(run.room.messages).toContainEqual(
					expect.objectContaining({ kind: 'seated', subject: 'inventory', from: 'assistant' }),
				);
			}
			expect(presence(exchange, 'unseated', 'inventory')).toEqual([]);
			expect(exchange?.summary?.text).toMatch(EIGHT);
		},
	);

	it.each([1, 2, 3])(
		'leaves a superseded constraint at broadcast to the summary (sample %i)',
		async (sample) => {
			const name = `corrects-${sample}`;
			const evidence = track(name);
			const room = await openRoom({
				attention: 'broadcast',
				specialist: answers(
					() => 'I will prepare a 10-unit dispatch plan using the old approved limit of 10.',
				),
			});
			const run = await simulate(room, {
				person: priya,
				actor: scriptedActor([
					'Prepare a warehouse dispatch plan. Correction: the approved limit is now 8 units; the old 10-unit limit is withdrawn. Do not dispatch anything.',
				]),
				exchanges: 1,
				exchangeMs: EXCHANGE_MS,
			});
			evidence.run = run;
			expectGradable(run);
			const [exchange] = run.exchanges;
			// At broadcast the specialist heard the correction. The assistant does not repeat it.
			expect(saidBy(exchange, 'assistant'), JSON.stringify(exchange?.discussion)).toEqual([]);
			expect(exchange?.summary?.text).toMatch(EIGHT);
			const verdict = await judge(run, [
				'The summary to priya reports that inventory planned on the withdrawn 10-unit limit, states that the approved limit is 8 units, and does not present the 10-unit plan as accepted.',
			]);
			evidence.verdict = verdict;
			expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
		},
	);

	it('does not steer valid work or turn an incomplete result into success', async () => {
		const evidence = track('incomplete');
		const room = await openRoom({
			attention: 'broadcast',
			specialist: answers(
				() =>
					'I could not read current warehouse stock because the stock service is unavailable. Dispatch capacity remains unknown; nothing was dispatched.',
			),
		});
		const run = await simulate(room, {
			person: priya,
			actor: scriptedActor([
				'Check whether the warehouse can dispatch 8 units today. Do not dispatch anything.',
			]),
			exchanges: 1,
			exchangeMs: EXCHANGE_MS,
		});
		evidence.run = run;
		expectGradable(run);
		expect(saidBy(run.exchanges[0], 'assistant')).toEqual([]);
		const verdict = await judge(run, [
			'The summary to priya says that the dispatch capacity is unknown, and it reports no success.',
		]);
		evidence.verdict = verdict;
		expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
	});

	it('honors an application override of default silence', async () => {
		const evidence = track('override');
		const room = await openRoom({
			attention: 'broadcast',
			specialist: answers(() => 'There are 8 units of SKU A in stock.'),
			instructions:
				'For this application, override default silence: publish exactly one ordinary message with the exact text "Inventory checkpoint recorded." for this exchange. Do not repeat it if it is already on the record. Write the closing summary normally.',
		});
		const run = await simulate(room, {
			person: priya,
			actor: scriptedActor(['Check warehouse stock for SKU A.']),
			exchanges: 1,
			exchangeMs: EXCHANGE_MS,
		});
		evidence.run = run;
		const [exchange] = run.exchanges;
		expect(saidBy(exchange, 'assistant')).toEqual([
			expect.objectContaining({ text: 'Inventory checkpoint recorded.' }),
		]);
		expect(exchange?.summary?.text).toMatch(EIGHT);
	});

	it('preserves source-only verification limits in the closing summary', async () => {
		const evidence = track('verification');
		const room = await openRoom({
			attention: 'broadcast',
			specialist: answers(
				() =>
					'I inspected the source of the static dispatch prototype. The source contains a stock-count label. I did not render it in a browser, run tests, or deploy it. Runtime behavior remains unverified; no release occurred and no files changed.',
			),
		});
		const run = await simulate(room, {
			person: priya,
			actor: scriptedActor([
				'Report what was verified about the warehouse dispatch prototype. Do not change files or release anything.',
			]),
			exchanges: 1,
			exchangeMs: EXCHANGE_MS,
		});
		evidence.run = run;
		expectGradable(run);
		const [exchange] = run.exchanges;
		expect(saidBy(exchange, 'assistant')).toEqual([]);
		const verdict = await judge(run, [
			'The summary to priya says that the check was an inspection of the source of a static prototype.',
			'The summary to priya says that the runtime behavior is unverified.',
			'The summary to priya says that nothing was released or deployed.',
		]);
		evidence.verdict = verdict;
		expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
	});

	// The cases below need more than one exchange, which the old helper could not run.

	it(
		'carries a revised request to the specialist in one directed message',
		async () => {
			const evidence = track('revision');
			const room = await openRoom({
				attention: 'named',
				specialist: answers((exchange) =>
					exchange.some((message) => SKU_B.test(message.text))
						? 'The warehouse has 5 units of SKU B available to dispatch today.'
						: STOCK,
				),
			});
			const run = await simulate(room, {
				person: priya,
				actor: scriptedActor([
					'How many units of SKU A can the warehouse dispatch today?',
					'Correction: I need the count for SKU B, not SKU A.',
				]),
				exchanges: 2,
				exchangeMs: EXCHANGE_MS,
			});
			evidence.run = run;
			expectGradable(run);
			const second = run.exchanges[1];
			const speech = saidBy(second, 'assistant');
			expect(speech, JSON.stringify(second?.discussion)).toHaveLength(1);
			expect(speech[0]).toMatchObject({ to: 'inventory', text: expect.stringMatching(SKU_B) });
			expect(second?.summary?.text).toMatch(FIVE);
			const verdict = await judge(run, [
				'The second summary to priya answers for SKU B, and does not give the SKU A count as the answer.',
			]);
			evidence.verdict = verdict;
			expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
		},
		TWO_EXCHANGES_MS,
	);

	it(
		'keeps a constraint of the first exchange in the second',
		async () => {
			const evidence = track('constraint');
			const room = await openRoom({
				attention: 'named',
				specialist: answers((exchange) =>
					exchange.some((message) => /plan/i.test(message.text))
						? 'I prepared a plan to dispatch 8 units of SKU A.'
						: STOCK,
				),
			});
			const run = await simulate(room, {
				person: priya,
				actor: scriptedActor([
					'Report the stock of SKU A. Do not dispatch anything this week.',
					'Now prepare a dispatch plan for SKU A.',
				]),
				exchanges: 2,
				exchangeMs: EXCHANGE_MS,
			});
			evidence.run = run;
			expectGradable(run);
			const speech = saidBy(run.exchanges[1], 'assistant');
			expect(speech, JSON.stringify(run.exchanges[1]?.discussion)).toHaveLength(1);
			expect(speech[0]).toMatchObject({ to: 'inventory' });
			const verdict = await judge(run, [
				"In the second exchange, the assistant's request to inventory carries the constraint that nothing is dispatched this week.",
				'The second summary to priya keeps the constraint that nothing is dispatched this week.',
			]);
			evidence.verdict = verdict;
			expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
		},
		TWO_EXCHANGES_MS,
	);

	it(
		'asks the person for a material fact, and uses it once given',
		async () => {
			const evidence = track('material-fact');
			const room = await openRoom({
				attention: 'broadcast',
				specialist: answers((exchange) =>
					exchange.some((message) => /A-100/.test(message.text))
						? 'The warehouse has 8 units of SKU A-100 available to dispatch today.'
						: 'I need the SKU before I can check the stock.',
				),
			});
			const run = await simulate(room, {
				person: priya,
				actor: agentActor({
					model: MODEL,
					thinking: THINKING,
					brief:
						'You want to know how many units the warehouse can dispatch today. The SKU is A-100. Give the SKU only when someone asks for it. Stop when you know the count.',
				}),
				exchanges: 3,
				exchangeMs: EXCHANGE_MS,
			});
			evidence.run = run;
			expectGradable(run, ['stopped', 'limit']);
			// At broadcast the specialist asks for the SKU. Only the summary relays the question.
			for (const exchange of run.exchanges) expect(saidBy(exchange, 'assistant')).toEqual([]);
			// The actor gives the SKU in a later exchange. The first criterion reads whether the assistant asked.
			expect(run.exchanges.slice(1).map((exchange) => exchange.sent)).toContainEqual(
				expect.stringMatching(/A-100/),
			);
			const verdict = await judge(run, [
				'The first summary to priya asks for the SKU, or says that the count waits on it, and reports no count.',
				'The last summary to priya states that 8 units can be dispatched today.',
			]);
			evidence.verdict = verdict;
			expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
		},
		THREE_EXCHANGES_MS,
	);

	// The cases below hold the rest of the assistant's purpose: an answer when a
	// person asks it, silence beside a specialist that a person asked, and
	// membership on request and on need only.

	it('answers a question that a person addresses to it at broadcast', async () => {
		const evidence = track('direct-question');
		const room = await openRoom({
			attention: 'broadcast',
			// A question to the assistant is not a request to the specialist.
			specialist: answers((exchange) => (exchange[0]?.to === 'assistant' ? undefined : STOCK)),
		});
		const run = await simulate(room, {
			person: priya,
			actor: scriptedActor([
				{
					text: 'Who in this room checks warehouse stock, and is that agent seated?',
					to: 'assistant',
				},
			]),
			exchanges: 1,
			exchangeMs: EXCHANGE_MS,
		});
		evidence.run = run;
		expect(run.ended).toBe('limit');
		const [exchange] = run.exchanges;
		const speech = saidBy(exchange, 'assistant');
		expect(speech, JSON.stringify(exchange?.discussion)).toHaveLength(1);
		expect(speech[0]).toMatchObject({ to: 'priya' });
		expect(saidBy(exchange, 'inventory')).toEqual([]);
		expect(presence(exchange, 'seated', 'inventory')).toEqual([]);
		expect(presence(exchange, 'unseated', 'inventory')).toEqual([]);
		const verdict = await judge(run, [
			"The assistant's message to priya names inventory as the agent that checks stock, and says that it is seated.",
		]);
		evidence.verdict = verdict;
		expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
	});

	it('stays silent when a person asks a named specialist directly', async () => {
		const evidence = track('direct-to-specialist');
		const room = await openRoom({ attention: 'named', specialist: answers(() => STOCK) });
		const run = await simulate(room, {
			person: priya,
			actor: scriptedActor([
				{ text: 'How many units of SKU A can you dispatch today?', to: 'inventory' },
			]),
			exchanges: 1,
			exchangeMs: EXCHANGE_MS,
		});
		evidence.run = run;
		expectGradable(run);
		const [exchange] = run.exchanges;
		expect(saidBy(exchange, 'assistant'), JSON.stringify(exchange?.discussion)).toEqual([]);
		expect(saidBy(exchange, 'inventory')).not.toEqual([]);
		expect(exchange?.summary?.text).toMatch(EIGHT);
	});

	it(
		'unseats a specialist when the person asks, and not before',
		async () => {
			const evidence = track('unseat');
			const room = await openRoom({
				attention: 'broadcast',
				specialist: answers((exchange) =>
					exchange.some((message) => /no longer needed/i.test(message.text)) ? undefined : STOCK,
				),
			});
			const run = await simulate(room, {
				person: priya,
				actor: scriptedActor([
					'Report the stock of SKU A.',
					'Thanks. Inventory is no longer needed here; remove it from the room.',
				]),
				exchanges: 2,
				exchangeMs: EXCHANGE_MS,
			});
			evidence.run = run;
			expectGradable(run);
			const [first, second] = run.exchanges;
			expect(presence(first, 'unseated', 'inventory')).toEqual([]);
			expect(presence(second, 'unseated', 'inventory')).toEqual([
				expect.objectContaining({ from: 'assistant' }),
			]);
			for (const exchange of run.exchanges) expect(saidBy(exchange, 'assistant')).toEqual([]);
			const verdict = await judge(run, [
				'The second summary to priya says that inventory left the room.',
			]);
			evidence.verdict = verdict;
			expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
		},
		TWO_EXCHANGES_MS,
	);

	it('seats no specialist when the request does not need one', async () => {
		const evidence = track('no-seat');
		const room = await openRoom({ specialist: answers(() => 'UNEXPECTED: inventory was seated.') });
		const run = await simulate(room, {
			person: priya,
			actor: scriptedActor([
				'For the record: the dispatch review is on Friday. No stock check is needed.',
			]),
			exchanges: 1,
			exchangeMs: EXCHANGE_MS,
		});
		evidence.run = run;
		expect(run.ended).toBe('limit');
		const [exchange] = run.exchanges;
		expect(presence(exchange, 'seated', 'inventory')).toEqual([]);
		expect(saidBy(exchange, 'inventory')).toEqual([]);
		expect(saidBy(exchange, 'assistant'), JSON.stringify(exchange?.discussion)).toEqual([]);
	});
});
