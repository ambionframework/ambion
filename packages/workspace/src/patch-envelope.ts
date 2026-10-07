/**
 * The envelope of the `apply_patch` tool: the text that names the files of a
 * patch and the operation on each one.
 *
 * ```
 * *** Begin Patch
 * *** Add File: <path>       lines that start with +
 * *** Delete File: <path>
 * *** Update File: <path>
 * *** Move to: <path>        optional, right after Update File
 * <the body of a V4A diff>
 * *** End Patch
 * ```
 *
 * The parser splits the text and checks the markers. It does not read a
 * body: `applyDiff` (`./apply-diff.ts`) reads each body. A patch may sit in a
 * shell heredoc, such as `apply_patch <<'EOF'` with `EOF` as the last line.
 * The envelope follows the `apply_patch` tool of Codex.
 */

/** One operation of a patch, with the body that `applyDiff` reads. */
export type PatchOperation =
	| { readonly kind: 'add'; readonly path: string; readonly body: string }
	| { readonly kind: 'delete'; readonly path: string }
	| {
			readonly kind: 'update';
			readonly path: string;
			readonly moveTo?: string;
			readonly body: string;
	  };

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const MOVE = '*** Move to:';
const END_OF_FILE = '*** End of File';

const HEADERS = [
	{ marker: '*** Add File:', kind: 'add' },
	{ marker: '*** Delete File:', kind: 'delete' },
	{ marker: '*** Update File:', kind: 'update' },
] as const;

/** The patch inside a shell heredoc, or the text itself when there is no heredoc. */
function unwrapHeredoc(text: string): string {
	const wrapped =
		/^(?:apply_patch|applypatch)?\s*<<[ \t]*(['"]?)(\w+)\1[ \t]*\r?\n([\s\S]*)\r?\n[ \t]*\2$/.exec(
			text,
		);
	return wrapped?.[3]?.trim() ?? text;
}

/** The header at the start of a line: the operation, and the path after the marker. */
function headerOf(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | undefined {
	for (const { marker, kind } of HEADERS) {
		if (line.startsWith(marker)) return { kind, path: line.slice(marker.length).trim() };
	}
	return undefined;
}

/** The index of the first line from `start` that is a header. The count of lines when there is none. */
function bodyEnd(lines: readonly string[], start: number): number {
	const found = lines.findIndex((line, index) => index >= start && headerOf(line) !== undefined);
	return found === -1 ? lines.length : found;
}

/** The lines of a body, with a check that no line starts with a marker that has no place there. */
function checkedBody(lines: readonly string[], from: number, to: number): string[] {
	const body = lines.slice(from, to);
	for (const [offset, line] of body.entries()) {
		if (line.startsWith('***') && line !== END_OF_FILE) {
			throw new Error(`Line ${from + offset + 1} of the patch is not valid here: ${line}`);
		}
	}
	return body;
}

function requirePath(path: string, line: number): string {
	if (path === '') throw new Error(`Line ${line} of the patch names no path.`);
	return path;
}

/** The operation `Update File` at `lines[index]`, with its optional `Move to` line. */
function parseUpdate(
	lines: readonly string[],
	index: number,
	path: string,
): { operation: PatchOperation; next: number } {
	const moveLine = lines[index + 1] ?? '';
	const move = moveLine.startsWith(MOVE);
	const first = index + (move ? 2 : 1);
	const next = bodyEnd(lines, first);
	const body = checkedBody(lines, first, next).join('\n');
	if (!move) return { operation: { kind: 'update', path, body }, next };
	const moveTo = requirePath(moveLine.slice(MOVE.length).trim(), index + 2);
	return { operation: { kind: 'update', path, moveTo, body }, next };
}

/** The operation that starts at `lines[index]`, and the index of the line after it. */
function parseOperation(
	lines: readonly string[],
	index: number,
): { operation: PatchOperation; next: number } {
	const line = lines[index] ?? '';
	const header = headerOf(line);
	if (header === undefined) {
		throw new Error(
			`Line ${index + 1} of the patch must start an operation with "*** Add File:", "*** Delete File:", or "*** Update File:". It reads: ${line}`,
		);
	}
	const path = requirePath(header.path, index + 1);
	if (header.kind === 'update') return parseUpdate(lines, index, path);
	const next = bodyEnd(lines, index + 1);
	const body = checkedBody(lines, index + 1, next);
	if (header.kind === 'add') {
		return { operation: { kind: 'add', path, body: body.join('\n') }, next };
	}
	if (body.length > 0) {
		throw new Error(`The operation "Delete File: ${path}" takes no lines after its header.`);
	}
	return { operation: { kind: 'delete', path }, next };
}

/** The lines of a patch with its closing marker removed. The first line is the opening marker. */
function envelopeLines(text: string): string[] {
	const lines = text.split(/\r?\n/);
	if (lines.length < 2 || lines[0]?.trim() !== BEGIN || lines.at(-1)?.trim() !== END) {
		throw new Error(
			`The patch must start with "${BEGIN}" and end with "${END}", each on its own line.`,
		);
	}
	return lines.slice(0, -1);
}

/**
 * The operations of a patch. A patch that breaks the envelope throws an
 * error that names the line.
 */
export function parsePatch(input: string): PatchOperation[] {
	const lines = envelopeLines(unwrapHeredoc(input.trim()));
	if (lines.length === 1) throw new Error('The patch holds no operation.');
	const operations: PatchOperation[] = [];
	for (let index = 1; index < lines.length;) {
		const { operation, next } = parseOperation(lines, index);
		operations.push(operation);
		index = next;
	}
	return operations;
}
