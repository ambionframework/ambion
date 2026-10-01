/**
 * The directories of one seat: its Claude config home, its scratch working
 * directory, and its home directory for the shell and the tools in it.
 *
 * The Claude Code executable keeps its sessions, its settings, and on Linux
 * its credentials in the config home. One home for each seat keeps the
 * sessions of two seats apart, and keeps the files of the host user out of
 * the seat.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The two directories of a seat. */
interface SeatDirs {
	/** The value of `CLAUDE_CONFIG_DIR`. */
	readonly config: string;
	/** The working directory of a seat that has no built-in tool and sets no `cwd`. */
	readonly work: string;
	/** The `HOME` of a seat that gets the allowlisted environment. */
	readonly home: string;
}

/** The directories of a seat, made on the first call. Every call returns the same ones. */
export type SeatHome = () => SeatDirs;

/**
 * One safe path segment for a name. A fixed prefix keeps `.` and `..` from
 * standing alone. `encodeURIComponent` removes each separator and each
 * control character, and `.` is escaped by hand because it keeps its form.
 * A lone surrogate becomes U+FFFD first, because the encoding refuses it.
 * Two names never give one segment, because the encoding can be reversed.
 */
export function segment(name: string): string {
	return `n-${encodeURIComponent(name.toWellFormed()).replaceAll('.', '%2E')}`;
}

/** Make a directory that only the host user can read. */
function privateDirectory(path: string): string {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
}

/**
 * The home of one seat. With `configRoot`, it is
 * `<resolve(configRoot)>/<room>/<seat>`. A relative root becomes absolute
 * once, because the executable reads `CLAUDE_CONFIG_DIR` raw and resolves it
 * against its own working directory, which can be the scratch directory.
 * Without it, the seat gets a private
 * directory under the temporary directory of the host.
 */
export function seatHome(configRoot: string | undefined, room: string, seat: string): SeatHome {
	let dirs: SeatDirs | undefined;
	return () => {
		if (dirs !== undefined) return dirs;
		const root =
			configRoot === undefined
				? mkdtempSync(join(tmpdir(), 'ambion-claude-'))
				: join(resolve(configRoot), segment(room), segment(seat));
		dirs = {
			config: privateDirectory(join(root, 'config')),
			work: privateDirectory(join(root, 'work')),
			home: privateDirectory(join(root, 'home')),
		};
		return dirs;
	};
}
