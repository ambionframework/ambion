import { defineAgent, defineHuman } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';
import { pi } from '@ambionframework/pi';
import type { Workspace } from '@ambionframework/workspace';

/** The people who use the Workbench. Each one reads results a different way. */
export const people = [
	{
		name: 'mira',
		role: 'Hardware lead',
		preferences: 'Lead with the part choice, the current and voltage margins, and the decision.',
	},
	{
		name: 'theo',
		role: 'Firmware engineer',
		preferences: 'Lead with pin assignments, timing, and the code-level steps.',
	},
	{
		name: 'sol',
		role: 'Lab technician',
		preferences: 'Lead with the wiring steps in order, and one thing to check at each step.',
	},
].map(({ name, role, preferences }) => ({
	...defineHuman({
		name,
		identity: `${name}, ${role.toLowerCase()} on the Workbench lab team.`,
		preferences,
	}),
	role,
}));

/** A person who can use the Workbench. */
export type Person = (typeof people)[number];

/** The shared rules every agent follows. The kernel adds the collaboration rules. */
const shared =
	'This is a lab workbench for a toy Arduino kit. Read /library for the datasheets and /shared/kit.md for the kit and the house rules before you act. ' +
	'Cite the exact datasheet path when you state a specification, for example /library/led-5mm.md. ' +
	'Do not invent a value that a datasheet does not give. If a datasheet does not cover a case, say so. ' +
	'The example connects no real hardware, so treat every measurement as a planned value, not a reading. ' +
	'Respect explicit human constraints; they override role defaults and survive every specialist handoff. When the person says not to edit files, do not call write or shell tools that change files; give the answer in your reply. ' +
	'Report only actions your tool results support. You have local file and shell tools, and no web, email, or hardware tools. ';

/** The specialists. Each one has a narrow scope and reports back once. */
const specialists = [
	{
		name: 'datasheets',
		identity:
			'Datasheets specialist. Finds and reads the datasheets in /library and states exact limits with their source.',
		instructions:
			'Answer part questions from /library. Give the limit, the units, and the file path. Compare parts when the design needs a choice. Never state a value without a datasheet path.',
	},
	{
		name: 'design',
		identity:
			'Design specialist. Chooses parts and values, does the circuit math, and explains the tradeoffs.',
		instructions:
			'Use the datasheet limits to choose values. Show the calculation, for example the series resistor from Ohm’s law. Keep every value within the board and part limits, and state the margin. Record a decision in /shared when the person permits file edits.',
	},
	{
		name: 'experiments',
		identity: 'Experiments specialist. Turns a question into a short, repeatable test plan.',
		instructions:
			'Write a numbered test plan: the setup, the variable to change, the control, the measurement, and the pass criterion. Keep it short and repeatable. Save a plan under /shared when the person permits file edits.',
	},
];

/** Build the team for one workspace. Every room reuses these definitions. */
export function team(workspace: Workspace) {
	const model = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
	const assistant = defineAssistant({
		model,
		instructions: shared,
		bundles: [workspace.tools()],
	});
	const specialistDefinitions = specialists.map(({ instructions, ...definition }) =>
		defineAgent({
			...definition,
			executor: pi({
				instructions: `${shared}${instructions} Report your result to the assistant, or to the specialist who asked you. Reply once when your assignment is done. Stay silent on acknowledgments and when there is no new work.`,
				model,
				bundles: [workspace.tools()],
			}),
		}),
	);
	return {
		workspace,
		assistant,
		specialists: specialistDefinitions,
		agents: [assistant, ...specialistDefinitions],
	};
}
