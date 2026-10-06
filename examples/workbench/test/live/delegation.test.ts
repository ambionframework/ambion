/**
 * Delegation through a breakout room on a real model. The assistant, scout, and maker run on the
 * executor kind that `AMBION_EXECUTOR` selects: `pi` (the default) or `codex`. Five claims:
 *
 * - The assistant opens a breakout room whose parent is `bringup`.
 * - The only agent in that room is `scout`.
 * - The report of the room reaches the journal of `bringup` as a message that starts with
 *   `breakout <room>:`.
 * - The assistant archives the room, and the canvas row of the room has the state `archived`.
 * - The assistant says the value to `mira` in `bringup`: a said message from `assistant` to `mira`
 *   that matches `20 mA`.
 *
 * Pi needs a key in the variable of the provider of `AMBION_MODEL`, or a stored sign-in for that
 * provider in `~/.ambion/pi/credentials.json`. Codex needs `CODEX_API_KEY`, or the host login
 * `auth.json` of Codex. Without a sign-in, the file skips. The seats of the other
 * executor kinds fail their activations, and the test uses none of them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { codexExecution } from '@ambionframework/codex';
import { fileCredentials, piExecution } from '@ambionframework/pi';
import { describe, expect, it } from 'vitest';
import { type ExecutorKind, hasKey, keyVariable, piModel, seatKinds } from '../../src/kinds.ts';
import { openWorkbench, type Workbench } from '../../src/workbench.ts';

const DEADLINE_MS = 300_000;

const CREDENTIALS = join(homedir(), '.ambion', 'pi', 'credentials.json');

/** Whether the credential file holds a sign-in for the provider of the Pi model. */
function signedIn(): boolean {
	if (!existsSync(CREDENTIALS)) return false;
	try {
		const stored = JSON.parse(readFileSync(CREDENTIALS, 'utf8')) as Record<string, unknown>;
		const model = piModel();
		return model.slice(0, Math.max(model.indexOf('/'), 0)) in stored;
	} catch {
		return false;
	}
}

const kind: ExecutorKind = seatKinds().assistant ?? 'pi';

/** Whether the host has the login of Codex. The test checks that the file exists and reads none of it. */
const codexLogin = () =>
	existsSync(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'));

const keyed = hasKey(kind);

const runnable = keyed || (kind === 'codex' ? codexLogin() : signedIn());

/** The execution of the run: a key wins, and else the stored sign-in. */
function execution() {
	if (kind === 'codex') return { codex: codexExecution() };
	return {
		pi: keyed ? piExecution() : piExecution({ credentials: fileCredentials(CREDENTIALS) }),
	};
}

const REQUEST =
	'Delegate this to a breakout room with the worker scout, and do not read the files yourself. ' +
	'Scout reads the LED datasheet /library/led-5mm.md in the shared library and reports the maximum ' +
	'forward current of the red LED. When the report arrives, archive the breakout room as done, ' +
	'and tell me the value.';

const VALUE = /20\s*mA/i;

const textsOf = (messages: readonly object[]) =>
	messages.map((message) => ('text' in message ? String(message.text) : ''));

function archivedState(directory: string, room: string): unknown {
	const database = new DatabaseSync(join(directory, 'rooms.db'));
	try {
		return (
			database.prepare('SELECT state FROM canvas_rooms WHERE name = ?').get(room) as
				{ state: string } | undefined
		)?.state;
	} finally {
		database.close();
	}
}

/** Whether the parent journal holds a said message from `assistant` to `mira` that gives the value. */
function answered(messages: readonly object[]): boolean {
	return messages.some(
		(message) =>
			'kind' in message &&
			message.kind === 'said' &&
			'from' in message &&
			message.from === 'assistant' &&
			'to' in message &&
			message.to === 'mira' &&
			'text' in message &&
			VALUE.test(String(message.text)),
	);
}

/** The breakout room of `bringup` once the assistant archived it, or the reason it has not. */
async function archivedBreakout(workbench: Workbench, directory: string): Promise<string> {
	const rooms = await workbench.rooms();
	const child = rooms.find((room) => room.parent === 'bringup');
	if (!child) throw new Error('No breakout room has `bringup` as its parent.');
	const parent = textsOf((await workbench.read('bringup', 0)).messages);
	if (!parent.some((text) => text.startsWith(`breakout ${child.name}:`)))
		throw new Error(`The parent holds no report of '${child.name}'.`);
	if (archivedState(directory, child.name) !== 'archived')
		throw new Error(`The room '${child.name}' is not archived.`);
	return child.name;
}

/** Throws until the assistant has answered the person with the value. */
async function requireAnswer(workbench: Workbench): Promise<void> {
	if (!answered((await workbench.read('bringup', 0)).messages))
		throw new Error('The parent holds no said message from `assistant` to `mira` with the value.');
}

async function describeRun(workbench: Workbench): Promise<string> {
	const rooms = await workbench.rooms();
	const parent = textsOf((await workbench.read('bringup', 0)).messages);
	return JSON.stringify(
		{
			parentMessages: parent,
			answeredPerson: answered((await workbench.read('bringup', 0)).messages),
			rooms: rooms.map(({ name, parent: of, status }) => ({ name, parent: of, status })),
		},
		null,
		2,
	);
}

describe.skipIf(!runnable)(`Workbench delegation on a real ${kind} model`, () => {
	it(
		'opens a breakout room for scout, receives its report, archives the room, and answers the person',
		async () => {
			const directory = await mkdtemp(join(tmpdir(), 'ambion-workbench-delegation-live-'));
			const workbench = await openWorkbench({
				directory,
				executions: execution(),
			});
			try {
				await workbench.visit('bringup', 'mira');
				await workbench.send(
					'bringup',
					'mira',
					`workbench-live-delegation-${keyVariable(kind)}`,
					REQUEST,
				);
				const deadline = Date.now() + DEADLINE_MS;
				let name = '';
				let reason = '';
				while (Date.now() < deadline && name === '') {
					try {
						const archived = await archivedBreakout(workbench, directory);
						await requireAnswer(workbench);
						name = archived;
					} catch (error) {
						reason = error instanceof Error ? error.message : String(error);
						await new Promise((resolve) => setTimeout(resolve, 2_000));
					}
				}
				if (name === '')
					throw new Error(
						`The delegation did not finish: ${reason}\n${await describeRun(workbench)}`,
					);
				const breakout = await workbench.read(name, 0);
				expect(
					breakout.participants.filter((seat) => seat.kind === 'agent').map((seat) => seat.name),
				).toEqual(['scout']);
				expect(archivedState(directory, name)).toBe('archived');
			} finally {
				await workbench.close().catch(() => undefined);
				await rm(directory, { recursive: true, force: true });
			}
		},
		DEADLINE_MS + 60_000,
	);
});
