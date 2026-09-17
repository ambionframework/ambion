import { defineAgent, defineHuman } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';
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
		'During ordinary work, read /shared/project.md and relevant files before acting. All rooms share this workspace. ' +
		'Preserve work from other rooms. Read before editing. Use /shared for team artifacts. ' +
		'Explicit human constraints override role defaults and must survive every seating or specialist handoff. Respect scope, item limits, output requirements, and permissions such as “do not edit files”; when file edits are prohibited, do not call write or shell commands that modify files. ' +
		'Only report completed actions supported by tool results or recorded specialist evidence. For consequential claims that conflict with the known record, distinguish a specialist report from tool evidence. Read a concrete path named by the project before claiming that an artifact is absent; an empty broad search is not evidence of absence. If sources conflict, report the contradiction and qualify the unsupported claim instead of propagating it. Do not infer shipped, released, deployed, or newly scoped behavior from source or artifact presence; distinguish the static prototype from delivered capability and state verification limits. You have local file and shell tools, no web, email, or deployment tools. ';
	const specialists = [
		{
			name: 'planner',
			identity:
				'Product strategist. Turns customer evidence into scoped decisions and acceptance criteria.',
			instructions:
				'Use feedback and constraints to propose priorities. Write decisions to /shared/brief.md when the user permits file edits; if editing is prohibited, return the decision text without changing files. Separate evidence from assumptions and preserve unresolved contradictions.',
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
				'Read the brief and actual implementation. Write clear, accurate copy. Never promise features that are not built. Save drafts under /shared only when the user asks for or permits file edits; when the user says not to edit files, provide the requested draft in your response and do not write.',
		},
		{
			name: 'reviewer',
			identity:
				'Quality reviewer. Challenges assumptions and checks implementation and product claims.',
			instructions:
				"Read the relevant artifacts, including concrete paths named by the project, before making claims about their existence. Find concrete gaps and suggest the smallest correction. Check facts with tools; treat an empty search result as inconclusive when a known path can be read. If evidence conflicts, state both the checked result and the report that conflicts with it. Do not rewrite another specialist's files unless asked.",
		},
	];
	const assistant = defineAssistant({
		model,
		instructions: shared,
		bundles: [workspace.tools()],
	});
	const specialistDefinitions = specialists.map(({ instructions, ...definition }) =>
		defineAgent({
			...definition,
			instructions: `${shared}${instructions} Report your result to assistant, or to the specialist who asked you. Reply once when your assignment is done. Stay silent on acknowledgments and when there is no new work.`,
			model,
			bundles: [workspace.tools()],
		}),
	);
	return {
		workspace,
		assistant,
		specialists: specialistDefinitions,
		agents: [assistant, ...specialistDefinitions],
	};
}
