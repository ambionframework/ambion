import { defineAgent, defineHuman, type ToolBundle } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';
import { claude } from '@ambionframework/claude';
import { codex } from '@ambionframework/codex';
import { pi } from '@ambionframework/pi';
import type { Workspace } from '@ambionframework/workspace';
import type { Instrument } from './instrument.ts';
import { CLAUDE_MODEL, CODEX_MODEL, piModel, seatKinds } from './kinds.ts';

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
export const shared =
	'This is a lab workbench for a toy Arduino kit. Read /library for the datasheets and /shared/kit.md for the kit and the house rules before you act. ' +
	'Cite the exact datasheet path when you state a specification, for example /library/led-5mm.md. ' +
	'Do not invent a value that a datasheet does not give. If a datasheet does not cover a case, say so. ' +
	'The example connects no real hardware, so treat every measurement as a planned value, not a reading. ' +
	'Respect explicit human constraints; they override role defaults and survive every specialist handoff. When the person says not to edit files, do not call write or shell tools that change files; give the answer in your reply. ' +
	'The lab database is the shared database of `sql`. It holds the projects, test_plans, runs, results, and operations tables. Those tables accept INSERT alone, and the database fills their provenance columns. ' +
	'Cite what you rely on in `refs`, one URI each. To cite a workspace file, call snapshot with its path, for example /library/led-5mm.md, and put the ref it gives in refs. A lab table is lab:///<table>, for example lab:///runs. The terminal opens a ref that names a snapshot, a table, or a message, and marks any other ref. ' +
	'Report only actions your tool results support. You have local file and shell tools, git repositories through `repos`, `clone` and `fork`, and no web, email, or hardware tools. ';

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
			'Use the datasheet limits to choose values. Show the calculation, for example the series resistor from Ohm’s law. Keep every value within the board and part limits, and state the margin. Write a decision to /shared when the person permits file edits. Add each run you plan with an INSERT into the runs table through `sql`, and read earlier runs and results with `sql`. Drive the simulated instruments with `operate`: led-current has a limit of 20 mA, and bench-supply has a limit of 5 V. An operation above a limit does not run. Ask the person of the exchange, wait for the answer, then call `approve_operation`. Start firmware from the firmware-sketch template: fork it with `fork` and set clone, then commit and push your branch.',
	},
	{
		name: 'experiments',
		identity: 'Experiments specialist. Turns a question into a short, repeatable test plan.',
		instructions:
			'Write a numbered test plan: the setup, the variable to change, the control, the measurement, and the pass criterion. Keep it short and repeatable. Save a plan under /shared when the person permits file edits. Add the plan with an INSERT into the test_plans table through `sql`, and read earlier runs and results with `sql`. Review firmware by cloning the fork that `repos` lists.',
	},
];

/** Build the team for one workspace. Every room reuses these definitions. */
export function team(workspace: Workspace, instrument: Instrument) {
	const model = piModel();
	// One list of bundles serves every agent, so every seat holds the same tools over one workspace.
	const bundles: ToolBundle[] = [workspace.tools(), instrument.tools()];
	const assistant = defineAssistant({ model, instructions: shared, bundles });
	const specialistDefinitions = specialists.map(({ instructions, ...definition }) => {
		const options = {
			instructions: `${shared}${instructions} Report your result to the assistant, or to the specialist who asked you. Reply once when your assignment is done. Stay silent on acknowledgments and when there is no new work.`,
			bundles,
		};
		return defineAgent({ ...definition, executor: executorFor(definition.name, options, model) });
	});
	return {
		workspace,
		assistant,
		specialists: specialistDefinitions,
		agents: [assistant, ...specialistDefinitions],
	};
}

/**
 * The executor of a specialist, on the executor kind that `seatKinds` names. Every
 * kind gets the same options, so every seat reaches the world only through
 * the same bundles. Pi has no native tool. A Claude seat has no built-in
 * tool and no option that names one. A Codex seat has no native tool.
 */
function executorFor(
	name: string,
	options: { instructions: string; bundles: ToolBundle[] },
	model: string,
) {
	switch (seatKinds[name]) {
		case 'claude':
			return claude({ ...options, model: CLAUDE_MODEL });
		case 'codex':
			return codex({
				...options,
				model: CODEX_MODEL,
				modelReasoningEffort: 'medium',
			});
		default:
			return pi({ ...options, model });
	}
}
