import { defineAgent, defineHuman } from '@ambionframework/ambion';

export const MODEL = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
export const ROOM_NAME = 'team';

export const human = defineHuman({
	name: 'human',
	identity: 'The person who asks the team questions and decides what to do next.',
	preferences: 'Give a short answer with the decision first and the reason after it.',
});

const planner = defineAgent({
	name: 'planner',
	identity: 'Planning Agent. Breaks questions into clear steps and identifies dependencies.',
	executor: pi({
		instructions: `
		You speak for the planning agent. Read the question and the other agent's
		contribution before you answer. Give a practical plan with its key dependency.
		Use short sentences. End your turn when you have nothing useful to add.
	`,
		model: MODEL,
	}),
});

const reviewer = defineAgent({
	name: 'reviewer',
	identity: 'Review Agent. Checks plans for risks, missing facts, and useful next actions.',
	executor: pi({
		instructions: `
		You speak for the review agent. Check the question and the proposed plan for
		missing facts or risks. State one useful correction or say that the plan is
		sound. Use short sentences. End your turn when you have nothing useful to add.
	`,
		model: MODEL,
	}),
});

export const AGENTS = [planner, reviewer];

export const COMPOSITION = {
	name: ROOM_NAME,
	// The planner is an ordinary room member. When an exchange closes, it may
	// write the short message the human reads using the same say tool.
	summary: planner.name,
	agents: AGENTS.map((agent) => agent.name),
	seats: {
		planner: 'broadcast',
		reviewer: 'broadcast',
	} as const,
	goal: 'Help the person make a clear decision with a practical plan and a review.',
};
