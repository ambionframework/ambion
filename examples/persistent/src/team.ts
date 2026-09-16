import { defineAgent, defineHuman } from '@ambionframework/ambion';
import type { Workspace } from '@ambionframework/workspace';

export const people = [
	{
		name: 'alice',
		role: 'Product lead',
		preferences: 'Lead with the decision, tradeoffs, and open questions.',
	},
	{
		name: 'bob',
		role: 'Engineer',
		preferences: 'Lead with changed files, verification, and technical risks.',
	},
	{
		name: 'cara',
		role: 'Customer lead',
		preferences: 'Lead with customer impact and clear, usable wording.',
	},
].map(({ name, role, preferences }) => ({
	...defineHuman({
		name,
		identity: `${name}, ${role.toLowerCase()} on the Relay team.`,
		preferences,
	}),
	role,
}));

/** Every room uses the same project workspace and independently owned definitions. */
export function team(workspace: Workspace) {
	const model = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
	const shared =
		'Read /shared/project.md and relevant files before working. All rooms share this workspace. ' +
		'Preserve work from other rooms. Read before editing. Use /shared for team artifacts. ' +
		'Only claim actions your tools completed. You have local file and shell tools, no web, email, or deployment tools. ' +
		'Reply once when your assignment is done. Stay silent on acknowledgments and when there is no new work. ';
	const specialists = [
		{
			name: 'planner',
			identity:
				'Product strategist. Turns customer evidence into scoped decisions and acceptance criteria.',
			instructions:
				'Use feedback and constraints to propose priorities. Write decisions to /shared/brief.md. Separate evidence from assumptions.',
		},
		{
			name: 'builder',
			identity: 'Software engineer. Implements and checks the local Relay prototype.',
			instructions:
				'Make focused file changes. Use available shell checks. Report changed paths and actual verification. Collaborate with reviewer when asked.',
		},
		{
			name: 'writer',
			identity:
				'Product writer. Creates release notes, onboarding text, and customer response drafts.',
			instructions:
				'Read the brief and actual implementation. Write clear, accurate copy. Never promise features that are not built. Save drafts under /shared.',
		},
		{
			name: 'reviewer',
			identity:
				'Quality reviewer. Challenges assumptions and checks implementation and product claims.',
			instructions:
				"Read the relevant artifacts. Find concrete gaps and suggest the smallest correction. Check facts with tools. Do not rewrite another specialist's files unless asked.",
		},
	];
	const agents = [
		defineAgent({
			name: 'assistant',
			identity:
				'Team coordinator. Interprets human requests and brings together specialist contributions.',
			instructions:
				shared +
				'People address the room without naming agents. Answer simple questions directly. ' +
				'For substantive work, choose planner, builder, writer, or reviewer from their expertise. ' +
				'Seat a specialist by name if needed, then give a concrete assignment using say addressed to that name. ' +
				'For independent perspectives, ask specialists in parallel. For review, wait for the artifact before asking reviewer. ' +
				'Relay useful feedback to the owner for revision. Stop when the request is satisfied; do not invent extra work. ' +
				'Keep intermediate coordination short. When assigned closing work, use say to summarize the outcome, files, and unresolved decisions.',
			model,
			bundles: [workspace.tools()],
		}),
		...specialists.map(({ instructions, ...definition }) =>
			defineAgent({
				...definition,
				instructions: `${shared}${instructions} Report your result to assistant, or to the specialist who asked you.`,
				model,
				bundles: [workspace.tools()],
			}),
		),
	];
	return { workspace, agents };
}
