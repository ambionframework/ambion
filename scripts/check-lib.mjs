/**
 * The pure parts of the gate: the steps, and the filter that turns the output
 * of a failed step into the lines a reader acts on.
 *
 * This module has no side effects on import. `check.mjs` runs the steps.
 */

/**
 * The steps of the gate, in report order. Each step runs one root script.
 * A step with `needs` is skipped when that step fails in the same run.
 */
const STEPS = [
	{ name: 'format', script: 'check:format', fix: 'run `pnpm format`' },
	{ name: 'lint', script: 'check:lint', fix: 'run `pnpm format:lint` for safe fixes' },
	{
		name: 'knip',
		script: 'check:knip',
		fix: 'delete the unused code or dependency; record a kept one in knip.json',
	},
	{ name: 'rules', script: 'check:lemmascript:gen' },
	{
		name: 'reports',
		script: 'test:reports',
		fix: 'rerun one: `node --test scripts/<name>.test.mjs`',
	},
	{ name: 'build', script: 'build' },
	{ name: 'types', script: 'check:types', needs: 'build' },
	{
		name: 'test',
		script: 'test:packages',
		needs: 'build',
		fix: 'rerun one: `pnpm --filter <package> exec vitest run <file>`',
	},
];

/** The steps that `names` select, in report order. Throws on a name that is no step. */
export function selectSteps(names) {
	if (names.length === 0) return STEPS;
	const unknown = names.filter((name) => !STEPS.some((step) => step.name === name));
	if (unknown.length > 0) {
		throw new Error(
			`unknown step: ${unknown.join(', ')}. Steps: ${STEPS.map((s) => s.name).join(' ')}`,
		);
	}
	return STEPS.filter((step) => names.includes(step.name));
}

/** Lines that carry no finding: banners, timings, passes, and wrappers of the real error. */
const NOISE = [
	/^\s*• (turbo \d|Packages in scope|Running |Remote caching)/,
	/^\s*(Tasks|Cached|Time|Failed):\s/,
	/^\s*ERROR\s+run failed/,
	/ERROR\s+command \(.*\) .* exited \(\d+\)$/,
	/WARNING\s+command finished with error, but continuing/,
	/cache (miss|hit|bypass), (executing|replaying)/,
	/^\s*(✓|✔)\s/,
	/^\s*ℹ /,
	/^\s*▶ /,
	/^\s*at .*[( ]node:/,
	/^Generated: .*\.dfy\.gen$/,
	/WARN\s+TypeScript 7\.0 does not yet have a stable API/,
	/Proxy environment variables detected/,
	/ELIFECYCLE/,
	/^\s*RUN\s+v\d/,
	/^\s*(Start at|Duration)\s/,
	/^\s*(❯|at) .*node_modules\//,
	/^\s*⎯+(\[\d+\/\d+\])?⎯*$/,
	/^\s*[\w:]+ ━{3,}/,
	/Some (errors|warnings) were emitted while running checks/,
	/^\s*Checked \d+ files? in /,
];

/** The text with every ANSI escape sequence and carriage return removed. */
export function plain(text) {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: an ANSI escape starts with ESC.
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}

/** A package-relative path in a line of one package's task, made relative to the root. */
function rootPaths(line, dir) {
	return line
		.replace(
			/(^|[\s(])((?:src|test|scripts)\/[\w./@-]+\.[cm]?[jt]sx?)\((\d+),(\d+)\)/g,
			`$1${dir}/$2:$3:$4`,
		)
		.replace(/(^|[\s(])((?:src|test|scripts)\/[\w./@-]+\.[cm]?[jt]sx?)/g, `$1${dir}/$2`);
}

/** A pnpm script header: `> name@version script /path`, then `> command`. */
const HEADER = /^> \S+@\S* \S+ \//;

/** One line without its turbo task prefix, the paths in it relative to the root, and its task. */
function untask(raw, dirs) {
	const match = /^(@?[\w/.-]+):([\w:-]+): ?(.*)$/.exec(raw);
	const dir = match ? dirs[match[1]] : undefined;
	if (!match || !dir) return { line: raw, task: undefined };
	return { line: rootPaths(match[3], dir), task: `${dir} ${match[2]}` };
}

/** The entries without the two lines of each pnpm script header. */
function withoutHeaders(entries) {
	return entries.filter(
		(entry, i) =>
			!HEADER.test(entry.line) &&
			!(entry.line.startsWith('> ') && i > 0 && HEADER.test(entries[i - 1].line)),
	);
}

/**
 * The lines of a failed step that a reader acts on. A turbo task prefix
 * (`@scope/name:task: `) becomes one header for each run of lines, and the
 * paths under it become relative to the root. `dirs` maps a package name to
 * its directory.
 */
export function findings(text, dirs = {}) {
	const entries = plain(text)
		.split('\n')
		.map((raw) => untask(raw, dirs));
	const out = [];
	let current;
	for (const { line, task } of withoutHeaders(entries)) {
		if (NOISE.some((pattern) => pattern.test(line))) continue;
		if (task && task !== current && line.trim() !== '') {
			current = task;
			out.push(`── ${task}`);
		}
		out.push(line.trimEnd());
	}
	return squeeze(out);
}

/** The lines without leading, trailing, or repeated blank lines. */
function squeeze(lines) {
	const out = [];
	for (const line of lines) {
		if (line === '' && (out.length === 0 || out.at(-1) === '')) continue;
		out.push(line);
	}
	while (out.at(-1) === '') out.pop();
	return out;
}

/** The turbo tasks that failed, from the `Failed:` lines of a run. */
export function failedTasks(text) {
	return [...plain(text).matchAll(/^\s*Failed:\s+(.+)$/gm)]
		.flatMap((match) => match[1].split(','))
		.map((task) => task.trim().replace(/^@ambionframework(-examples)?\//, ''))
		.filter((task) => task !== '');
}

/** At most `limit` lines, and a last line that names the full log. A limit of 0 keeps all. */
export function clip(lines, limit, log) {
	if (limit === 0 || lines.length <= limit) return lines;
	return [...lines.slice(0, limit), `… ${lines.length - limit} more lines in ${log}`];
}
