/**
 * The skills of a seat: folders in the workspace that hold skills in the
 * agentskills.io format, and the reminder that lists them.
 *
 * Pi's loader reads each folder over the agent's `ExecutionEnv`, and Pi's
 * formatter writes the list: the name, the description, and the location of
 * each `SKILL.md`. The seat reads a skill with `read` and runs its scripts
 * with `bash`, so a skill works the same on every executor.
 */
import {
	BACKGROUND_CONTEXT,
	type ExecutionEnv,
	formatSkillsForSystemPrompt,
	loadSkills,
	withAbortSignal,
} from '@earendil-works/pi-agent-core';
import type { WorkspaceEnv } from './backend.ts';
import type { WorkspaceResource } from './resource.ts';

/** The most skills one reminder names. The reminder counts the rest. */
export const MAX_SKILLS = 50;

/** The folders `tools({ skills })` takes, checked and copied. */
export function skillFolders(skills: unknown): readonly string[] {
	const folders = typeof skills === 'string' ? [skills] : skills;
	if (
		!Array.isArray(folders) ||
		folders.length === 0 ||
		folders.some((folder) => typeof folder !== 'string' || folder.trim() === '')
	) {
		throw new Error('Workspace skills must be a folder path or a nonempty list of folder paths.');
	}
	return Object.freeze([...folders]);
}

/**
 * The list of the skills in `folders` that the model may use, or nothing
 * when there is none. A missing folder holds no skill. A `SKILL.md` with no
 * description is not a skill.
 */
async function listing(
	env: ExecutionEnv,
	folders: readonly string[],
	signal: AbortSignal,
): Promise<string | undefined> {
	const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
	const { skills } = await loadSkills(env, [...folders], context);
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return undefined;
	const text = formatSkillsForSystemPrompt(visible.slice(0, MAX_SKILLS));
	const rest = visible.length - MAX_SKILLS;
	return rest > 0 ? `${text}\nand ${rest} more skills in ${folders.join(', ')}` : text;
}

/** The list of the skills in `folders`, read as the seat's agent on the bash owner. */
export function remindSkills(
	shell: WorkspaceResource<WorkspaceEnv>['use'],
	folders: readonly string[],
): (agent: string, signal: AbortSignal) => Promise<string | undefined> {
	return (agent, signal) => shell({ name: agent }, (env) => listing(env, folders, signal), signal);
}
