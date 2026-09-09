/**
 * The cast and the scenario the chaos tests drive: two seats that answer
 * every question once, an assistant that writes once per draft, two
 * people, and three questions. No test runner is imported here, so a
 * child process runs the same scenario the tests do.
 */
import {
	type AgentDefinition,
	defineAgent,
	defineHuman,
	type HumanDefinition,
} from '../../src/index.ts';
import {
	answersLastQuestion,
	byAgent,
	quiet,
	type Script,
	summarise,
	toolNames,
	toolResultTexts,
} from './scripted.ts';

export const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	instructions: 'Answer what was asked, once.',
	model: 'scripted/assistant',
});
export const product = defineAgent({
	name: 'product',
	identity: 'The product.',
	instructions: 'x',
	model: 'scripted/product',
});
export const colleague = defineAgent({
	name: 'colleague',
	identity: 'The second product.',
	instructions: 'x',
	model: 'scripted/colleague',
});
export const priya = defineHuman({
	name: 'priya',
	identity: 'Project manager.',
	preferences: 'Lead with the decision.',
});
export const sam = defineHuman({ name: 'sam', identity: 'Site foreman.' });

export const agents: readonly AgentDefinition[] = [assistant, product, colleague];
const people = [priya.name, sam.name];

/** Every seat answers the last question once; the assistant writes once per draft. */
export const script: Script = byAgent({
	product: answersLastQuestion(people),
	colleague: answersLastQuestion(people),
	assistant: (context) =>
		toolNames(context).includes('summarise') && !toolResultTexts(context).includes('delivered')
			? summarise('The one message.')
			: quiet(),
});

/** The script with a wait before every answer, so a kill from outside lands mid-activation. */
export const slowly =
	(ms: number): Script =>
	async (context, agent, call) => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		return script(context, agent, call);
	};

// -- the scenario -------------------------------------------------------------

export interface Question {
	person: HumanDefinition;
	key: string;
	text: string;
	to?: AgentDefinition;
	/** Who answers it: every seat it wakes. */
	answered: string[];
}

/** Three questions: two the whole room answers, one directed at one seat. */
export const questions: readonly Question[] = [
	{ person: priya, key: 'q1', text: 'First?', answered: [product.name, colleague.name] },
	{ person: sam, key: 'q2', text: 'Second?', answered: [product.name, colleague.name] },
	{ person: sam, key: 'q3', text: 'Third?', to: product, answered: [product.name] },
];

/** The lease and the backoff a room killed from outside runs with, and is resumed with. */
export const TIMING = { wake: { expiry: 1_500 }, retry: { backoff: (n: number) => n * 300 } };
