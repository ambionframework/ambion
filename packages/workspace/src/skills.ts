/**
 * The skills of an agent: a fixed set of skills in the agentskills.io
 * format, the guidance that lists them, and the copy in the agent's home.
 *
 * `loadSkills` reads a source once on the host, checks each skill, and
 * freezes the files. The bundle guidance lists each skill at
 * `~/.skills/<name>/SKILL.md`, and `syncSkills` writes the files there. The
 * seat reads a skill with `read` and runs its scripts with `bash`, so a
 * skill works the same on every executor. The design contract is
 * `docs/skills.md`.
 */

import type { ComposeMacro } from '@ambionframework/ambion';
import type { WorkspaceEnv } from './backend.ts';
import { shellQuote } from './execution-env.ts';
import { macrosOf } from './skill-macros.ts';
import {
	decodeText,
	FRONTMATTER,
	MAX_DESCRIPTION,
	MAX_NAME,
	mappingOf,
	NAME,
	refuse,
} from './skill-text.ts';
import { hashesOf, readSource, type SourceFiles, type SourceInput } from './sources.ts';

/** The folder in each agent's home that holds the copy of its skills. */
const SKILLS_HOME = '~/.skills';

/** The file in `SKILLS_HOME` that names the files of the copy. The copy step writes it last. */
export const MANIFEST = '.manifest';

/** The folder inside a skill whose files the copy makes executable. */
const SCRIPTS = 'scripts';

const MAX_COMPATIBILITY = 500;

/** One skill of a set. */
export interface SkillInfo {
	/** The name of the skill, which is also the name of its folder. */
	readonly name: string;
	/** When to use the skill. The guidance shows it. */
	readonly description: string;
	/** The files of the skill, relative to its folder, `SKILL.md` first. */
	readonly files: readonly string[];
}

/** A checked, frozen set of skills. Only `loadSkills` makes one. */
export interface SkillSet {
	readonly skills: readonly SkillInfo[];
	/** Every file of every skill, relative to the root of the set. */
	readonly files: SourceFiles;
	/** The files that the copy makes executable: each file under `<skill>/scripts/`. */
	readonly scripts: readonly string[];
	/**
	 * The macros of the set, from each `<skill>/macros/<name>.js`. They are
	 * the frozen text of the files at load, so an edit of the copy changes none.
	 */
	readonly macros: readonly ComposeMacro[];
	/** The text of the manifest of a copy of this set. */
	readonly manifest: string;
}

/** The sets that `loadSkills` made. */
const made = new WeakSet<SkillSet>();

/** The path `path` in segments, when it is relative and names no `.` or `..`. */
function segmentsOf(path: string): string[] {
	const segments = path.split('/');
	if (segments.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\')))
		refuse(`the file path '${path}' is not a plain relative path.`);
	return segments;
}

/** The files of the source, by the folder of their skill. */
function byFolder(files: SourceFiles): Map<string, string[]> {
	const folders = new Map<string, string[]>();
	for (const path of Object.keys(files).sort()) {
		const [folder, ...rest] = segmentsOf(path);
		if (folder === undefined || rest.length === 0)
			refuse(
				`the file '${path}' is outside a skill folder. Put each file in the folder of a skill.`,
			);
		folders.set(folder, [...(folders.get(folder) ?? []), rest.join('/')]);
	}
	return folders;
}

/** The frontmatter of a `SKILL.md`, as an object. */
function frontmatterOf(folder: string, bytes: Uint8Array): Record<string, unknown> {
	const text = decodeText(`the SKILL.md of '${folder}'`, bytes);
	const yaml = FRONTMATTER.exec(text)?.[1];
	if (yaml === undefined)
		refuse(`the SKILL.md of '${folder}' starts with no frontmatter between two '---' lines.`);
	return mappingOf(`the frontmatter of '${folder}'`, yaml);
}

/** The name of the skill in `folder`, checked against the agentskills.io rules. */
function checkName(folder: string, name: unknown): string {
	if (name !== folder) refuse(`the name of '${folder}' must equal its folder name.`);
	if (folder.length > MAX_NAME || !NAME.test(folder))
		refuse(
			`the name '${folder}' must be 1 to ${MAX_NAME} characters of a-z, 0-9 and single hyphens, with no hyphen at either end.`,
		);
	return folder;
}

/** The description of the skill in `folder`, checked. */
function checkDescription(folder: string, description: unknown): string {
	if (typeof description !== 'string' || description.trim() === '')
		refuse(`the skill '${folder}' has no description.`);
	if (description.length > MAX_DESCRIPTION)
		refuse(`the description of '${folder}' is longer than ${MAX_DESCRIPTION} characters.`);
	return description;
}

/** One skill: its folder, its files, and its frontmatter, checked. */
function skillOf(folder: string, paths: readonly string[], files: SourceFiles): SkillInfo {
	const skill = files[`${folder}/SKILL.md`];
	if (skill === undefined) refuse(`the skill folder '${folder}' has no SKILL.md.`);
	const data = frontmatterOf(folder, skill);
	const { compatibility } = data;
	if (
		compatibility !== undefined &&
		(typeof compatibility !== 'string' || compatibility.length > MAX_COMPATIBILITY)
	)
		refuse(
			`the compatibility of '${folder}' must be text of at most ${MAX_COMPATIBILITY} characters.`,
		);
	return Object.freeze({
		name: checkName(folder, data.name),
		description: checkDescription(folder, data.description),
		files: Object.freeze(['SKILL.md', ...paths.filter((path) => path !== 'SKILL.md')]),
	});
}

/**
 * Read `source` once, check each skill, and freeze the files. Each folder
 * at the root of the source is one skill, with a `SKILL.md` and any
 * scripts, references, and assets. The error names the first file that
 * breaks a rule.
 */
export async function loadSkills(source: SourceInput): Promise<SkillSet> {
	const files = await readSource(source);
	const folders = byFolder(files);
	if (folders.size === 0) refuse('the source holds no skill.');
	const skills = [...folders].map(([folder, paths]) => skillOf(folder, paths, files));
	const frozen = Object.freeze(
		Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
	);
	const scripts = Object.keys(frozen).filter((path) => path.split('/')[1] === SCRIPTS);
	const macros = [...folders].flatMap(([folder, paths]) => macrosOf(folder, paths, files));
	const set: SkillSet = Object.freeze({
		skills: Object.freeze(skills),
		files: frozen,
		scripts: Object.freeze(scripts),
		macros: Object.freeze(macros),
		manifest: `${JSON.stringify({ files: [...hashesOf(frozen)], scripts })}\n`,
	});
	made.add(set);
	return set;
}

/** The set `skills`, when `loadSkills` made it. */
export function skillSetOf(skills: unknown): SkillSet {
	if (typeof skills !== 'object' || skills === null || !made.has(skills as SkillSet))
		throw new Error('Workspace skills must be a skill set that loadSkills made.');
	return skills as SkillSet;
}

/** One skill of the guidance: its name, its description, and the path of its file. */
interface ListedSkill {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * The list of skills for a system prompt, as XML. It derives from the skill
 * list of the agent harness of Pi (earendil-works/pi, MIT License, Mario
 * Zechner). No skills give an empty text.
 */
function formatSkills(skills: readonly ListedSkill[]): string {
	if (skills.length === 0) return '';
	return [
		'The following skills provide specialized instructions for specific tasks.',
		'Read the full skill file when the task matches its description.',
		'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
		'',
		'<available_skills>',
		...skills.flatMap((skill) => [
			'  <skill>',
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(skill.description)}</description>`,
			`    <location>${escapeXml(skill.filePath)}</location>`,
			'  </skill>',
		]),
		'</available_skills>',
	].join('\n');
}

/** The guidance that lists the skills of `set` at their place in the agent's home. */
export function skillGuidance(set: SkillSet): string {
	const listed = formatSkills(
		set.skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: `${SKILLS_HOME}/${skill.name}/SKILL.md`,
		})),
	);
	return [
		listed,
		`Your skills are in ${SKILLS_HOME}. The folder of a skill also holds its scripts and`,
		'resources. Read a file with read, and run a script with bash.',
	].join('\n');
}

/** The value of a result, or its error thrown. */
function must<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!result.ok) throw result.error;
	return result.value;
}

/** Make each script of `set` executable. The paths are absolute, so none starts with a hyphen. */
async function markScripts(
	env: WorkspaceEnv,
	set: SkillSet,
	root: string,
	signal?: AbortSignal,
): Promise<void> {
	if (set.scripts.length === 0) return;
	const paths = set.scripts.map((path) => shellQuote(`${root}/${path}`)).join(' ');
	const ran = must(await env.exec(`chmod +x ${paths}`, undefined, signal));
	if (ran.exitCode !== 0)
		throw new Error(`chmod of the skill scripts exited with code ${ran.exitCode}.`);
}

/**
 * Make `SKILLS_HOME` hold the files of `set`. A manifest that matches
 * costs one read. Otherwise the step removes the folder, writes each file,
 * marks the scripts, and writes the manifest last, so a cut copy leaves
 * no manifest and the next step writes the copy again.
 */
export async function syncSkills(
	env: WorkspaceEnv,
	set: SkillSet,
	signal?: AbortSignal,
): Promise<void> {
	const root = must(await env.absolutePath(SKILLS_HOME, signal));
	const held = await env.readTextFile(`${root}/${MANIFEST}`, signal);
	if (held.ok && held.value === set.manifest) return;
	must(await env.remove(root, { recursive: true, force: true }, signal));
	const folders = new Set(
		Object.keys(set.files).map((path) => path.slice(0, path.lastIndexOf('/'))),
	);
	for (const folder of folders)
		must(await env.createDir(`${root}/${folder}`, { recursive: true }, signal));
	for (const [path, bytes] of Object.entries(set.files))
		must(await env.writeFile(`${root}/${path}`, bytes, signal));
	await markScripts(env, set, root, signal);
	must(await env.writeFile(`${root}/${MANIFEST}`, set.manifest, signal));
}
