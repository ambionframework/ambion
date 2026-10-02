/**
 * One live case: an agent actor and an agent judge on a real provider. It
 * proves that a model id resolves, and that each agent ends with its tool
 * call. The room runs on the scripted execution, so only the actor and the
 * judge spend. `AMBION_MODEL` names the model, and `JUDGE_MODEL` names the
 * judge's model, `AMBION_MODEL` by default.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { byAgent, quiet, say } from '@ambionframework/ambion/testing';
import { describe, expect, it, onTestFailed } from 'vitest';
import {
	type AgentActorOptions,
	type AgentJudgeOptions,
	agentActor,
	agentJudge,
	type Simulation,
	simulate,
	type Verdict,
} from '../../src/index.ts';
import { open, priya } from '../support.ts';

const MODEL = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? MODEL;
const THINKING = process.env.AMBION_THINKING as AgentActorOptions['thinking'];
const JUDGE_THINKING = process.env.JUDGE_THINKING as AgentJudgeOptions['thinking'];
const keyOf = (model: string) =>
	`${(model.split('/')[0] ?? '').toUpperCase().replace(/-/g, '_')}_API_KEY`;
const live = describe.skipIf(!process.env[keyOf(MODEL)] || !process.env[keyOf(JUDGE_MODEL)]);

/** Write the simulation and the verdict of a failed case where a person can read them. */
function keepOnFailure(
	name: string,
	evidence: { simulation?: Simulation; verdict?: Verdict },
): void {
	onTestFailed(() => {
		const dir = new URL('./runs/', import.meta.url);
		mkdirSync(dir, { recursive: true });
		const path = new URL(`${name}.json`, dir);
		const replacer = (_key: string, value: unknown) =>
			value instanceof Error ? value.message : value;
		writeFileSync(path, JSON.stringify(evidence, replacer, 2));
		process.stdout.write(`simulator live · ${name}: evidence in ${path.pathname}\n`);
	});
}

live('an agent actor and an agent judge on a real model', () => {
	it('asks about Thursday, stops with the answer, and passes the judge', async () => {
		const evidence: { simulation?: Simulation; verdict?: Verdict } = {};
		keepOnFailure('agent', evidence);
		const room = await open(
			byAgent({
				desk: (step) =>
					step.results.length > 0 ? quiet() : say('The forecast for Thursday is dry.', 'priya'),
			}),
			['desk'],
		);
		const actor = agentActor({
			model: MODEL,
			...(THINKING === undefined ? {} : { thinking: THINKING }),
			brief: 'Ask the desk whether Thursday will be dry. Stop as soon as you know.',
		});
		// A polite model may thank the desk before it stops, so the bound leaves room for it.
		evidence.simulation = await simulate(room, { person: priya, actor, messages: 3 });
		const { simulation } = evidence;
		expect(['stopped', 'limit']).toContain(simulation.ended);
		expect(simulation.moves[0]).toHaveProperty('text');
		const judge = agentJudge({
			model: JUDGE_MODEL,
			...(JUDGE_THINKING === undefined ? {} : { thinking: JUDGE_THINKING }),
		});
		evidence.verdict = await judge(simulation, ['The desk tells the person that Thursday is dry.']);
		const { verdict } = evidence;
		const cost = (simulation.usage.actor.cost ?? 0) + (verdict.usage?.cost ?? 0);
		process.stdout.write(
			`simulator live · agent: ${simulation.moves.length} moves, $${cost.toFixed(4)} for the actor and the judge\n`,
		);
		expect(verdict.findings).toHaveLength(1);
		expect(verdict.pass, JSON.stringify(verdict.findings)).toBe(true);
	});
});
