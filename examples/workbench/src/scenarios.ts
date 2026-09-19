import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attention } from '@ambionframework/ambion';

/** The rooms share one kit. Each goal shows a distinct collaboration pattern. */
export const scenarios: {
	name: string;
	goal: string;
	pattern: string;
	prompt: string;
	seats: Record<string, Attention>;
}[] = [
	{
		name: 'bringup',
		goal: 'Bring up an Arduino Uno with one blinking LED. Choose a series resistor and confirm the current stays within the board and LED limits.',
		pattern: 'Datasheet check → design decision',
		prompt:
			'Blink one red LED on pin 13. Pick a series resistor from the datasheets and show the current stays within the limits.',
		seats: { datasheets: 'named', design: 'named' },
	},
	{
		name: 'sensing',
		goal: 'Add an HC-SR04 distance sensor to the Uno. Plan a short test that measures the range accuracy.',
		pattern: 'Design → test plan',
		prompt:
			'Wire the HC-SR04 to the Uno and plan a repeatable test that measures distance accuracy from 5 cm to 100 cm.',
		seats: { design: 'named', experiments: 'named' },
	},
	{
		name: 'power',
		goal: 'Estimate the current the kit draws on USB power. Confirm the board can supply it and note the margin.',
		pattern: 'Datasheet check → current budget',
		prompt:
			'Add up the current for the Uno, one LED at 10 mA, and the HC-SR04. Confirm USB power is enough and state the margin.',
		seats: { datasheets: 'named', design: 'named' },
	},
];

const libraryDirectory = fileURLToPath(new URL('../library/', import.meta.url));

/** The starter files under /shared. Existing edits always remain intact. */
const sharedFiles: Record<string, string> = {
	'shared/kit.md': `# The kit

**This workbench holds one toy Arduino kit.** Read /library for the
datasheets before you claim a specification.

## Parts

- One Arduino Uno R3 board.
- One 5 mm red LED.
- Carbon-film resistors, E12 series, 1/4 W.
- One HC-SR04 ultrasonic distance unit.
- One momentary push button.

## House rules

- Read the datasheet in /library before you state a limit. Cite the path.
- The board is not connected. Every measurement is a planned value.
- Record a decision in /shared/notes.md when the person permits file edits.
`,
	'shared/notes.md': `# Lab notes

Status: empty. Record decisions and test plans here.
`,
};

async function copyLibrary(path: string): Promise<void> {
	const entries = await readdir(libraryDirectory, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const source = resolve(libraryDirectory, entry.name);
		const target = resolve(path, 'library', entry.name);
		await mkdir(dirname(target), { recursive: true });
		await writeIfAbsent(target, await readFile(source, 'utf8'));
	}
}

async function writeIfAbsent(target: string, content: string): Promise<void> {
	try {
		await writeFile(target, content, { flag: 'wx' });
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
	}
}

/** Add missing datasheets and starter files. Existing edits always remain. */
export async function seedWorkspace(path: string): Promise<void> {
	await copyLibrary(path);
	for (const [name, content] of Object.entries(sharedFiles)) {
		const target = resolve(path, name);
		await mkdir(dirname(target), { recursive: true });
		await writeIfAbsent(target, content);
	}
}
