/**
 * The lab's repositories: a git backend with one read-only template, the
 * firmware sketch for the kit.
 *
 * An agent forks the template with `fork`, clones the fork into its home,
 * and pushes its branch with `git` in `bash`. The storage is one SQLite
 * file beside the other lab files, so a push survives a restart of the
 * host. The template source is `examples/workbench/templates`.
 *
 * The backend signs each token with a secret of this process. The
 * just-bash `git` asks for a token at each request, so a new secret after
 * a restart loses nothing.
 */

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromDirectory, gitBackend, sqliteGitStorage } from '@ambionframework/git';

const templatesDirectory = fileURLToPath(new URL('../templates/', import.meta.url));

/** The templates, by name. A template never changes: a change takes a new name. */
const templates = {
	'firmware-sketch': {
		description:
			'Arduino Uno firmware for the kit: a pin map, a sketch that blinks the LED and reads the HC-SR04, and a sweep of the LED resistor.',
		source: fromDirectory(resolve(templatesDirectory, 'firmware-sketch')),
	},
};

/** The git backend of the lab, with its storage at `location`, or `':memory:'` for a test. */
export function labRepositories(location: string) {
	return gitBackend({
		storage: sqliteGitStorage(location),
		secret: randomBytes(32).toString('hex'),
		templates,
	});
}
