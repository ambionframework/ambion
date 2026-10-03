/**
 * The macros of a skill: `loadSkills` reads `<skill>/macros/<name>.js` and
 * refuses a bad file, a seat runs a macro by name over a real workspace and
 * a real SQLite file, an edit of the copy in `~/.skills` changes nothing
 * that runs, and a seat without `compose` takes the same skill set.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AmbionError,
	COMPOSE_GUIDANCE,
	type ComposeRequest,
	createRuntime,
	defineAgent,
	type Step,
	startRoom,
} from '@ambionframework/ambion';
import { describeExecutor, invokeTool } from '@ambionframework/ambion/hosting';
import { callTool, quiet, say, scripted, settled } from '@ambionframework/ambion/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { functionRuntime } from '../../ambion/test/support/compose-runtime.ts';
import { andrei, roomName } from '../../ambion/test/support/room.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { memoryBackend } from '../../just-bash/src/index.ts';
import { loadSkills, openWorkspace, type Workspace } from '../src/index.ts';
import { hashesOf } from '../src/sources.ts';
import { sqliteBackend } from '../src/sqlite-entry.ts';

/** The macro of the design note: it reads the paths of the runs with a label, and snapshots them. */
const SNAPSHOT_DRIFT = `/*---
description: Snapshot the files of every run with a label. Returns the count and the refs.
uses: [sql, snapshot]
args:
  type: object
  properties: { label: { type: string, minLength: 1 } }
  required: [label]
  additionalProperties: false
---*/
const runs = await tools.sql({ sql: 'SELECT path FROM runs WHERE label = ? ORDER BY path', params: [args.label], rows: 500 });
const { refs } = await tools.snapshot({ paths: runs.rows.map((row) => row.path) });
return { runs: runs.count, refs };
`;

const SKILL_MD =
	'---\nname: lab-drift\ndescription: Find the drifting runs.\n---\nRun the macro lab-drift/snapshot-drift.\n';

const LAB_DRIFT = {
	'lab-drift/SKILL.md': SKILL_MD,
	'lab-drift/macros/snapshot-drift.js': SNAPSHOT_DRIFT,
};

/** A macro file with the header lines given and the body `return 1;`. */
const macroFile = (...header: string[]) => `/*---\n${header.join('\n')}\n---*/\nreturn 1;\n`;

const GOOD = ['description: Say one.', 'uses: [sql]', 'args: { type: object }'];

/** The skill set of `LAB_DRIFT` with one macro file replaced by `text`. */
const withMacro = (text: string, file = 'lab-drift/macros/one.js') =>
	loadSkills({ 'lab-drift/SKILL.md': SKILL_MD, [file]: text });

describe('loadSkills and macros', () => {
	it('reads each macro file with its header, its body, and the blob hash of the file', async () => {
		const set = await loadSkills({
			...LAB_DRIFT,
			'lab-drift/macros/README.md': 'Notes.\n',
			'other/SKILL.md': '---\nname: other\ndescription: Another.\n---\nSteps.\n',
			'other/macros/one.js': macroFile(...GOOD),
		});
		expect(set.macros.map((macro) => macro.name)).toEqual([
			'lab-drift/snapshot-drift',
			'other/one',
		]);
		const [drift, one] = set.macros;
		expect(drift).toEqual({
			name: 'lab-drift/snapshot-drift',
			description: 'Snapshot the files of every run with a label. Returns the count and the refs.',
			uses: ['sql', 'snapshot'],
			args: {
				type: 'object',
				properties: { label: { type: 'string', minLength: 1 } },
				required: ['label'],
				additionalProperties: false,
			},
			code: SNAPSHOT_DRIFT.slice(SNAPSHOT_DRIFT.indexOf('---*/\n') + '---*/\n'.length),
			hash: hashesOf(set.files).get('lab-drift/macros/snapshot-drift.js'),
		});
		expect(one?.code).toBe('return 1;\n');
		expect(drift?.hash).toMatch(/^[0-9a-f]{40}$/);
		expect(
			Object.isFrozen(set.macros) && Object.isFrozen(drift) && Object.isFrozen(drift?.args),
		).toBe(true);
		expect(Object.keys(set.files)).toContain('lab-drift/macros/README.md');
	});

	it('gives no macro for a skill with no macros folder', async () => {
		const set = await loadSkills({ 'lab-drift/SKILL.md': SKILL_MD });
		expect(set.macros).toEqual([]);
	});

	it.each([
		['no header', 'return 1;\n', "starts with no header: a '/*---' line"],
		['a header that never ends', '/*---\ndescription: x\nreturn 1;\n', 'starts with no header'],
		['an empty header', '/*---\n---*/\nreturn 1;\n', 'starts with no header'],
		['a header that is not YAML', '/*---\ndescription: [\n---*/\n', 'is not YAML'],
		['a header that is a list', '/*---\n- a\n---*/\n', 'is not a YAML mapping'],
		[
			'no description',
			macroFile('uses: [sql]', 'args: { type: object }'),
			'description must be text that is not blank',
		],
		[
			'a blank description',
			macroFile('description: " "', 'uses: [sql]', 'args: { type: object }'),
			'description must be text',
		],
		[
			'a description over 1024 characters',
			macroFile(`description: ${'a'.repeat(1025)}`, 'uses: [sql]', 'args: { type: object }'),
			'longer than 1024 characters',
		],
		[
			'no uses',
			macroFile('description: x', 'args: { type: object }'),
			'uses must be a non-empty list of tool names',
		],
		[
			'a uses that is text',
			macroFile('description: x', 'uses: sql', 'args: { type: object }'),
			'uses must be a non-empty list',
		],
		[
			'an empty uses',
			macroFile('description: x', 'uses: []', 'args: { type: object }'),
			'uses must be a non-empty list',
		],
		[
			'a uses with a number',
			macroFile('description: x', 'uses: [sql, 3]', 'args: { type: object }'),
			'uses must be a non-empty list',
		],
		['no args', macroFile('description: x', 'uses: [sql]'), 'args must be a JSON Schema object'],
		[
			'args that are text',
			macroFile('description: x', 'uses: [sql]', 'args: object'),
			'args must be a JSON Schema object',
		],
		[
			'args with an unknown type',
			macroFile('description: x', 'uses: [sql]', 'args: { type: banana }'),
			'args is not a JSON Schema',
		],
		[
			'args with a reference',
			macroFile('description: x', 'uses: [sql]', 'args: { $ref: "#/a" }'),
			"args holds the keyword '$ref' at the top",
		],
		[
			'args with a keyword that Check ignores',
			macroFile(
				'description: x',
				'uses: [sql]',
				'args: { type: object, properties: { a: { type: string, bogus: 1 } } }',
			),
			"the keyword 'bogus' at properties.a",
		],
		['an unknown header field', macroFile(...GOOD, 'when: always'), "holds the field 'when'"],
	])('refuses a macro with %s, and names the file', async (_name, text, message) => {
		await expect(withMacro(text)).rejects.toThrow(/^Skill set: /);
		await expect(withMacro(text)).rejects.toThrow('lab-drift/macros/one.js');
		await expect(withMacro(text)).rejects.toThrow(message);
	});

	it.each([
		['a name with a capital', 'lab-drift/macros/One.js'],
		['a name with an underscore', 'lab-drift/macros/snap_shot.js'],
		['a name with two hyphens in a row', 'lab-drift/macros/a--b.js'],
		['a name that starts with a hyphen', 'lab-drift/macros/-a.js'],
		['no name', 'lab-drift/macros/.js'],
		['a name over 64 characters', `lab-drift/macros/${'a'.repeat(65)}.js`],
	])('refuses a macro file with %s', async (_name, file) => {
		await expect(withMacro(macroFile(...GOOD), file)).rejects.toThrow(
			/^Skill set: .*must be 1 to 64 characters/,
		);
	});

	it('refuses a macro in a folder below macros', async () => {
		await expect(withMacro(macroFile(...GOOD), 'lab-drift/macros/more/one.js')).rejects.toThrow(
			'must sit directly in the folder',
		);
	});

	it('refuses a macro file that is not UTF-8', async () => {
		const bytes = {
			read: async () => ({
				'lab-drift/SKILL.md': new TextEncoder().encode(SKILL_MD),
				'lab-drift/macros/one.js': new Uint8Array([0xff, 0xfe]),
			}),
		};
		await expect(loadSkills(bytes)).rejects.toThrow(
			"the macro 'lab-drift/macros/one.js' is not UTF-8 text",
		);
	});
});

let serial = 0;

/** A temporary directory that the test removes at its end. */
async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'ambion-macros-'));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** A workspace with a memory shell and a SQLite file, and the lab data in both. */
async function lab(withSql = true): Promise<Workspace> {
	const dir = await scratch();
	serial += 1;
	const workspace = openWorkspace({
		name: `macros-${serial}`,
		backend: {
			bash: memoryBackend(),
			...(withSql ? { sql: sqliteBackend(join(dir, 'lab.db')) } : {}),
		},
	});
	onTestFinished(() => workspace.dispose());
	if (!withSql) return workspace;
	await workspace.use({ name: 'ada' }, async (env) => {
		for (const name of ['a', 'b', 'c']) {
			const made = await env.createDir('/shared', undefined);
			if (!made.ok) throw made.error;
			const written = await env.writeFile(`/shared/${name}.md`, `${name}\n`);
			if (!written.ok) throw written.error;
		}
	});
	const seeded = await workspace.sql?.use({ name: 'ada' }, (env) =>
		env.run(
			"CREATE TABLE runs(label TEXT, path TEXT); INSERT INTO runs VALUES ('drift','/shared/c.md'), ('ok','/shared/b.md'), ('drift','/shared/a.md'), ('o''drift', '/shared/b.md')",
			{ maxRows: 1 },
		),
	);
	if (seeded?.ok !== true)
		throw new Error(`The lab data was not seeded: ${JSON.stringify(seeded)}`);
	return workspace;
}

const MACRO = 'lab-drift/snapshot-drift';
const COMPOSE_MACRO = { macro: MACRO, args: { label: 'drift' } };

describe('a seat that runs a macro by name', () => {
	it('runs the stored code over a real workspace and SQLite file, approves it by hash, and ignores an edit of ~/.skills', async () => {
		const workspace = await lab();
		const skills = await loadSkills(LAB_DRIFT);
		const [macro] = skills.macros;
		const asked: ComposeRequest[] = [];
		const logged: Step[] = [];
		const read: string[] = [];
		const seat = defineAgent({
			name: 'ada',
			identity: 'Runs the lab.',
			executor: describeExecutor({
				kind: 'scripted',
				instructions: 'Run macros.',
				bundles: [workspace.tools({ skills })],
				compose: {
					runtime: functionRuntime,
					approve: (request) => {
						asked.push(request);
						return 'allow';
					},
				},
			}),
		});
		const room = stopAtEnd(
			await startRoom({
				name: roomName('macro-room'),
				agents: [seat],
				runtime: createRuntime({ logger: (traced) => void logged.push(traced.step) }),
				execution: scripted(async (step, _seat, request) => {
					if (request === 1) return callTool('compose', COMPOSE_MACRO);
					if (request === 2) {
						await edit(workspace);
						return callTool('compose', COMPOSE_MACRO);
					}
					read.push(...step.results.map((result) => result.text));
					return request === 3 ? say('done') : quiet();
				}),
			}),
		);
		await (await room.visit(andrei)).send({ text: 'Snapshot the drift.' });
		await settled(room);
		const refs = await workspace.snapshot(['/shared/a.md', '/shared/c.md']);
		const first = JSON.parse(read[0] ?? '');
		expect(first).toEqual({ runs: 2, refs });
		expect(JSON.parse(read[1] ?? '')).toEqual(first);
		expect(asked).toEqual([
			{ macro: MACRO, hash: macro?.hash, args: { label: 'drift' } },
			{ macro: MACRO, hash: macro?.hash, args: { label: 'drift' } },
		]);
		// Two runs of two nested calls each.
		const nested = logged.filter((step) => 'parent' in step && step.type === 'tool_call');
		expect(nested.map((step) => ('name' in step ? step.name : step.type))).toEqual([
			'sql',
			'snapshot',
			'sql',
			'snapshot',
		]);
	});

	it('refuses args that break the schema before the approval, with no ledger and no nested step', async () => {
		const workspace = await lab();
		const skills = await loadSkills(LAB_DRIFT);
		const asked: ComposeRequest[] = [];
		const executor = describeExecutor({
			kind: 'scripted',
			instructions: 'Run macros.',
			bundles: [workspace.tools({ skills })],
			compose: {
				runtime: functionRuntime,
				approve: (request) => {
					asked.push(request);
					return 'allow';
				},
			},
		});
		const tool = executor.tools.find((one) => one.name === 'compose');
		if (tool === undefined) throw new Error('The executor has no compose tool.');
		const steps: Step[] = [];
		const ctx = { agent: { name: 'ada', identity: 'Ada.' }, callId: 'c1', room: 'lab' };
		const refused = await invokeTool(
			tool,
			{ macro: MACRO, args: { label: 5 } },
			ctx,
			(step) => void steps.push(step),
		).catch((error: unknown) => error);
		expect(refused).toMatchObject({ name: 'ComposeFailure' });
		expect((refused as Error & { details: unknown }).message).toContain(
			"The arguments of the macro 'lab-drift/snapshot-drift' do not match its schema: label must be string",
		);
		expect((refused as Error & { details: unknown }).details).toMatchObject({
			status: 'failed',
			calls: [],
		});
		expect([asked, steps]).toEqual([[], []]);
	});

	it('quotes a label in the SQL, so a quote in the arguments finds its own row', async () => {
		const workspace = await lab();
		const skills = await loadSkills(LAB_DRIFT);
		const seat = defineAgent({
			name: 'ada',
			identity: 'Runs the lab.',
			executor: describeExecutor({
				kind: 'scripted',
				instructions: 'Run macros.',
				bundles: [workspace.tools({ skills })],
				compose: { runtime: functionRuntime },
			}),
		});
		const read: string[] = [];
		const room = stopAtEnd(
			await startRoom({
				name: roomName('macro-quote'),
				agents: [seat],
				execution: scripted((step, _seat, request) => {
					if (request === 1)
						return callTool('compose', { macro: MACRO, args: { label: "o'drift" } });
					read.push(...step.results.map((result) => result.text));
					return quiet();
				}),
			}),
		);
		await (await room.visit(andrei)).send({ text: 'Snapshot.' });
		await settled(room);
		expect(JSON.parse(read[0] ?? '')).toMatchObject({ runs: 1 });
	});
});

/** Replace the macro in the copy of `~/.skills` with code that returns another value. */
async function edit(workspace: Workspace): Promise<void> {
	await workspace.use({ name: 'ada' }, async (env) => {
		const root = await env.absolutePath('~/.skills/lab-drift/macros');
		if (!root.ok) throw root.error;
		const made = await env.createDir(root.value, { recursive: true });
		if (!made.ok) throw made.error;
		const path = `${root.value}/snapshot-drift.js`;
		const written = await env.writeFile(
			path,
			'/*---\ndescription: Edited.\nuses: [sql]\nargs: { type: object }\n---*/\nreturn "edited";\n',
		);
		if (!written.ok) throw written.error;
		const back = await env.readTextFile(path);
		expect(back.ok && back.value).toContain('edited');
	});
}

describe('a seat that takes the skill set with and without compose', () => {
	it('lists the macros in the guidance of a seat with compose, and none on a seat without it', async () => {
		const workspace = await lab();
		const skills = await loadSkills(LAB_DRIFT);
		const bundle = workspace.tools({ skills });
		const options = { kind: 'scripted', instructions: 'Run.', bundles: [bundle] };
		const plain = describeExecutor(options);
		const composing = describeExecutor({ ...options, compose: { runtime: functionRuntime } });
		expect(plain.tools.map((tool) => tool.name)).toEqual(
			composing.tools.map((tool) => tool.name).filter((name) => name !== 'compose'),
		);
		expect(plain.guidance).not.toContain(MACRO);
		expect(plain.guidance).not.toContain(COMPOSE_GUIDANCE);
		expect(composing.guidance).toContain(
			`The macros of your skills. Run one with compose({ macro, args }):\n- ${MACRO}: Snapshot the files of every run with a label. Returns the count and the refs.`,
		);
		// The skills guidance lists the skill, and has no macro line of its own.
		expect(composing.guidance?.match(new RegExp(MACRO, 'g'))).toHaveLength(1);
	});

	it('refuses a macro whose tool the workspace lacks, when the seat has compose', async () => {
		const workspace = await lab(false);
		const skills = await loadSkills(LAB_DRIFT);
		const options = {
			kind: 'scripted',
			instructions: 'Run.',
			bundles: [workspace.tools({ skills })],
		};
		expect(() => describeExecutor(options)).not.toThrow();
		expect(() => describeExecutor({ ...options, compose: { runtime: functionRuntime } })).toThrow(
			AmbionError,
		);
		expect(() => describeExecutor({ ...options, compose: { runtime: functionRuntime } })).toThrow(
			"The macro 'lab-drift/snapshot-drift' uses 'sql'",
		);
	});

	it('refuses two bundles that carry one macro name', async () => {
		const workspace = await lab();
		const skills = await loadSkills(LAB_DRIFT);
		expect(() =>
			describeExecutor({
				kind: 'scripted',
				instructions: 'Run.',
				bundles: [workspace.tools({ skills }), { tools: [], macros: skills.macros }],
				compose: { runtime: functionRuntime },
			}),
		).toThrow("Two macros are named 'lab-drift/snapshot-drift'");
	});
});
