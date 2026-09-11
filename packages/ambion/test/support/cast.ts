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
} from '../../src/internal.ts';
import {
	answersEveryQuestion,
	answersLastQuestion,
	byAgent,
	quiet,
	type Script,
	summarise,
	toolNames,
	toolResultTexts,
	unanswered,
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

const assistantScript: Script = (context) =>
	toolNames(context).includes('summarise') && !toolResultTexts(context).includes('delivered')
		? summarise('The one message.')
		: quiet();

/** Every seat answers the last question once; the assistant writes once per draft. */
export const script: Script = byAgent({
	product: answersLastQuestion(people),
	colleague: answersLastQuestion(people),
	assistant: assistantScript,
});

/** One answer the record must hold once. */
export interface Answer {
	seat: string;
	text: string;
}

/**
 * The cast a world runs: the stream every runtime over the room runs, and
 * what the record must come to. The stream's own state survives a crash
 * of the room, the way a model does.
 */
export interface Cast {
	readonly script: Script;
	/** Every answer the record must hold once, for one question. */
	answers(question: Question): Answer[];
	/** The people the summaries are written for, in order. */
	readonly summaries: readonly string[];
	/** How many activations the cast itself failed: every one is an error on the stream. */
	failures(): number;
}

/** Every seat answers every question once, first time. */
export const steady = (): Cast => ({
	script,
	answers: (question) =>
		question.answered.map((seat) => ({ seat, text: `${seat} on ${question.text}` })),
	summaries: [priya.name, sam.name],
	failures: () => 0,
});

/**
 * A cast under trouble. The product's model is down at the start of the
 * first activation that takes a person's question, and the room wakes it
 * again after the backoff. The colleague's answers are questions to the
 * product, so a seat's say wakes a peer and the peer answers it, across a
 * crash like a person's. A failure in a pass the activation rebuilt after
 * the record moved is not in this cast: the lease spoke in its first
 * pass, so it answers its wake, and what the rebuilt pass was answering
 * is lost (backlog item 31).
 */
export function troubled(): Cast {
	const seen = new Set<string>();
	let failed = 0;
	const productScript: Script = (context, name, call) => {
		const next = unanswered(context, name, people)[0];
		const starting = toolResultTexts(context).length === 0;
		if (starting && next !== undefined && !seen.has(next)) {
			seen.add(next);
			failed += 1;
			throw new Error('the model is down');
		}
		return answersEveryQuestion([...people, colleague.name])(context, name, call);
	};
	return {
		script: byAgent({
			product: productScript,
			colleague: answersLastQuestion(people),
			assistant: assistantScript,
		}),
		answers: (question) =>
			question.answered.flatMap((seat) => {
				const own = { seat, text: `${seat} on ${question.text}` };
				return seat === colleague.name
					? [own, { seat: product.name, text: `${product.name} on ${own.text}` }]
					: [own];
			}),
		summaries: [priya.name, sam.name],
		failures: () => failed,
	};
}

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
