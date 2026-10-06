import { defineAgent, definePerson, type ToolBundle } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';
import type { Canvas } from '@ambionframework/canvas';
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
	...definePerson({
		name,
		identity: `${name}, ${role.toLowerCase()} on the Workbench lab team.`,
		preferences,
	}),
	role,
}));

/** A person who can use the Workbench. */
export type Person = (typeof people)[number];

/**
 * The rules of the specialists. The assistant reads its own short text: it
 * states no specification, writes no file, and runs no instrument.
 */
export const shared =
	'This is a lab workbench for a toy Arduino kit. Read /library for the datasheets and /shared/kit.md for the kit and the house rules before you act. ' +
	'Cite the exact datasheet path when you state a specification, for example /library/led-5mm.md. ' +
	'Do not invent a value that a datasheet does not give. If a datasheet does not cover a case, say so. ' +
	'No real hardware is connected, so every measurement is a planned value. ' +
	'Respect explicit human constraints; they override role defaults. When the person says not to edit files, do not call write or shell tools that change files; give the answer with say. ' +
	'The lab database is the shared database of `sql`. ' +
	'Cite what you rely on in `refs`, one URI each. A lab table is lab:///<table>, for example lab:///runs. A ref that names a snapshot, a table, or a message opens for the person; any other ref shows as a mark. ' +
	'Report only actions your tool results support. You have no web or email. ';

/** What the assistant reads as application instructions. */
const assistantInstructions =
	'This is a lab workbench for a toy Arduino kit. The specialists read /library and /shared; you do not. ' +
	'Respect explicit human constraints and carry them into each request. ' +
	'Report only actions your tool results support.';

/** The specialists. Each one has a narrow scope and reports back once. */
const specialists = [
	{
		name: 'datasheets',
		identity:
			'Datasheets specialist. Finds and reads the datasheets in /library and states exact limits with their source. Leaves the choice of a value and the circuit math to design.',
		instructions:
			'Answer part questions from /library. Give the limit, the units, and the file path. Compare parts when the design needs a choice. Never state a value without a datasheet path.',
	},
	{
		name: 'design',
		identity:
			'Design specialist. Chooses parts and values, does the circuit math, and explains the tradeoffs.',
		instructions:
			'Use the datasheet limits to choose values. When a datasheets message in the record gives a limit, cite that message and do not read the file again. Show the calculation, for example the series resistor from Ohm’s law. Keep every value within the board and part limits, and state the margin. Write a decision to /shared when the person permits file edits. Add each run you plan with an INSERT into the runs table through `sql`, and read earlier runs and results with `sql`. Drive the simulated instruments with `operate`. When the goal is firmware, start from the firmware-sketch template: fork it with `fork` and set clone, then commit and push your branch.',
	},
	{
		name: 'experiments',
		identity: 'Experiments specialist. Turns a question into a short, repeatable test plan.',
		instructions:
			'Write a numbered test plan: the setup, the variable to change, the control, the measurement, and the pass criterion. Keep it short and repeatable. Save a plan under /shared when the person permits file edits. Add the plan with an INSERT into the test_plans table through `sql`, and read earlier runs and results with `sql`. When the goal is firmware, review it by cloning the fork that `repos` lists.',
	},
];

/**
 * The worker team. No root room seats these definitions, so each one has a
 * home and a process list of its own. A worker has no instrument: an
 * operation above the limit needs a person, and a breakout room has none.
 */
const workers = [
	{
		name: 'scout',
		identity:
			'Scout. Reads the datasheets and the lab records and reports what they say, with the path of each source.',
		instructions:
			'Read /library, /shared, and the lab database with `sql`. Change no file and add no record. Report with `report` once, with the facts and their sources.',
	},
	{
		name: 'maker',
		identity:
			'Maker. Writes the files and the lab records that a delegated task needs, and reports what it wrote.',
		instructions:
			'Write the files under /shared that the task names, and add the lab records with `sql`. Report with `report` once, with the path of each file and the id of each record.',
	},
];

/** The names of the worker team, for `breakout.team`. */
export const workerNames: readonly string[] = workers.map((worker) => worker.name);

/**
 * Build the team for one workspace. Every room reuses these definitions. The
 * canvas comes first, because `defineAgent` reads a bundle when it defines an agent.
 */
export function team(
	workspace: Workspace,
	instrument: Instrument,
	canvas: Pick<Canvas, 'tools' | 'workerTools'>,
) {
	const model = piModel();
	// One list of bundles serves every specialist, so every seat holds the same tools over one workspace.
	const bundles: ToolBundle[] = [workspace.tools(), instrument.tools()];
	// The assistant plans the work of a person, so it alone can open a breakout room.
	const assistant = defineAssistant({
		instructions: assistantInstructions,
		bundles: [...bundles, canvas.tools()],
		executor: (parts) => executorFor('assistant', parts, model),
	});
	const specialistDefinitions = specialists.map(({ instructions, ...definition }) => {
		const options = {
			instructions: `${shared}${instructions} Your assignment is the message addressed to you, or the marked request when it names your field. Without one, end silently. Report your result with a say that has no to. Answer a question that another specialist addressed to you with a directed say to that specialist. Hand an artifact that a colleague continues to that colleague with a directed say. Reply once when your assignment is done. Stay silent on acknowledgments and when there is no new work.`,
			bundles,
		};
		return defineAgent({ ...definition, executor: executorFor(definition.name, options, model) });
	});
	const workerBundles: ToolBundle[] = [workspace.tools(), canvas.workerTools()];
	const workerDefinitions = workers.map(({ instructions, ...definition }) =>
		defineAgent({
			...definition,
			executor: executorFor(
				definition.name,
				{
					instructions: `${shared}${instructions} Your assignment is the message addressed to you. Call \`report\` inside the exchange that activated you. Stay silent when there is no new work.`,
					bundles: workerBundles,
				},
				model,
			),
		}),
	);
	return {
		workspace,
		assistant,
		specialists: specialistDefinitions,
		workers: workerDefinitions,
		agents: [assistant, ...specialistDefinitions, ...workerDefinitions],
	};
}

/**
 * The executor of a seat, on the executor kind that `seatKinds` names. Every
 * kind gets the same options, so every seat reaches the world only through
 * the same bundles. Pi has no native tool. A Claude seat has no built-in
 * tool and no option that names one. A Codex seat has no native tool.
 */
function executorFor(
	name: string,
	options: { instructions: string; bundles: readonly ToolBundle[] },
	model: string,
) {
	switch (seatKinds()[name]) {
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
