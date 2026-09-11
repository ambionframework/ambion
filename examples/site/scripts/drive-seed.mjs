/**
 * Turn `drive/` into `src/drive-seed.ts`: one record of path to text.
 *
 * The room seeds its workspace from that module, so it reads no file at run
 * time and runs on a host with no disk. Run `pnpm seed` after every edit
 * under `drive/`. `--check` proves the module holds what `drive/` holds, and
 * compares the records, so the formatter may lay the file out as it likes.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DRIVE = fileURLToPath(new URL('../drive', import.meta.url));
const OUT = fileURLToPath(new URL('../src/drive-seed.ts', import.meta.url));

/** Every checked-in document, keyed by the path it takes in the drive. */
function read() {
	const files = readdirSync(DRIVE, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
	return Object.fromEntries(
		files.map((full) => [
			`/${full.slice(DRIVE.length + 1).replaceAll('\\', '/')}`,
			readFileSync(full, 'utf8'),
		]),
	);
}

function module(seed) {
	const entries = Object.entries(seed)
		.map(([path, text]) => `\t${JSON.stringify(path)}: ${JSON.stringify(text)},`)
		.join('\n');
	return `/**
 * The documents checked in under \`drive/\`, as one record of path to text.
 *
 * \`scripts/drive-seed.mjs\` writes this file. Do not edit it: edit \`drive/\`
 * and run \`pnpm seed\`. The room seeds its workspace from here, so it reads
 * no file at run time and runs on a host with no disk.
 */
export const DRIVE_SEED: Record<string, string> = {
${entries}
};
`;
}

const seed = read();
if (process.argv.includes('--check')) {
	const { DRIVE_SEED } = await import(OUT);
	const same = JSON.stringify(DRIVE_SEED) === JSON.stringify(seed);
	if (!same) {
		process.stderr.write('src/drive-seed.ts is out of step with drive/. Run `pnpm seed`.\n');
		process.exit(1);
	}
	process.stdout.write(`src/drive-seed.ts holds all ${Object.keys(seed).length} documents.\n`);
} else {
	writeFileSync(OUT, module(seed));
	process.stdout.write(`wrote ${OUT}\n`);
}
