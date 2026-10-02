/**
 * The macros of a skill: `<skill>/macros/<name>.js`. A file opens with a
 * YAML block comment, `/*---` to `---*\/`, and the rest is the body that
 * `compose` runs. `loadSkills` reads each file once and keeps the text with
 * the blob hash of the file (`docs/skills.md`).
 */

import { type ComposeMacro, composeMacro } from '@ambionframework/ambion';
import {
	decodeText,
	FRONTMATTER,
	MAX_DESCRIPTION,
	MAX_NAME,
	mappingOf,
	NAME,
	refuse,
} from './skill-text.ts';
import { blobHash, type SourceFiles } from './sources.ts';

/** The folder inside a skill that holds its macros. */
const MACROS = 'macros';

/** The header: a block comment whose lines are a frontmatter. The group is the frontmatter. */
const HEADER = /^\/\*(---[ \t]*\n[\s\S]*?\n---)\*\/[ \t]*(?:\n|$)/;

/** The fields of a header. */
const FIELDS = ['description', 'uses', 'args'];

/** The name of the macro that `path` holds, or undefined when the file is not a macro. */
function stemOf(skill: string, path: string): string | undefined {
	const [folder, ...rest] = path.split('/');
	if (folder !== MACROS || !path.endsWith('.js')) return undefined;
	if (rest.length !== 1)
		refuse(`the macro '${skill}/${path}' must sit directly in the folder '${skill}/${MACROS}'.`);
	const stem = path.slice(MACROS.length + 1, -'.js'.length);
	if (stem.length > MAX_NAME || !NAME.test(stem))
		refuse(
			`the macro file '${skill}/${path}' has the name '${stem}', which must be 1 to ${MAX_NAME} characters of a-z, 0-9 and single hyphens, with no hyphen at either end.`,
		);
	return stem;
}

/** The fields of the header of the macro at `file`, and its body. */
function parts(file: string, text: string): { header: Record<string, unknown>; body: string } {
	const found = HEADER.exec(text);
	const yaml = found === null ? undefined : FRONTMATTER.exec(`${found[1]}\n`)?.[1];
	if (found === null || yaml === undefined)
		return refuse(
			`the macro '${file}' starts with no header: a '/*---' line, YAML, and a '---*/' line.`,
		);
	const header = mappingOf(`the header of '${file}'`, yaml);
	const extra = Object.keys(header).find((key) => !FIELDS.includes(key));
	if (extra !== undefined)
		refuse(
			`the header of '${file}' holds the field '${extra}'. Its fields are ${FIELDS.join(', ')}.`,
		);
	return { header, body: text.slice(found[0].length) };
}

/** One macro: its header and body checked, and the blob hash of the file. */
function macroOf(skill: string, stem: string, file: string, bytes: Uint8Array): ComposeMacro {
	const { header, body } = parts(file, decodeText(`the macro '${file}'`, bytes));
	const { description } = header;
	if (typeof description === 'string' && description.length > MAX_DESCRIPTION)
		refuse(`the description of the macro '${file}' is longer than ${MAX_DESCRIPTION} characters.`);
	try {
		return composeMacro({
			name: `${skill}/${stem}`,
			description,
			uses: header.uses,
			args: header.args,
			code: body,
			hash: blobHash(bytes),
		});
	} catch (error) {
		return refuse(`the macro '${file}': ${(error as Error).message}.`);
	}
}

/** The macros of the skill `skill`, in path order. `paths` are relative to its folder. */
export function macrosOf(
	skill: string,
	paths: readonly string[],
	files: SourceFiles,
): ComposeMacro[] {
	return paths.flatMap((path) => {
		const stem = stemOf(skill, path);
		const file = `${skill}/${path}`;
		const bytes = files[file];
		return stem === undefined || bytes === undefined ? [] : [macroOf(skill, stem, file, bytes)];
	});
}
