import type { FileContent, FileEntry } from './workbench.ts';

/** The files whose path holds every word of the query, in the order the host lists them. */
function matchFiles(files: readonly FileEntry[], query: string): FileEntry[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return files.filter((file) => words.every((word) => file.path.toLowerCase().includes(word)));
}

/**
 * The files panel, without drawing: a search box, the files that match it, and the
 * file the person chose. The chosen file loads as the selection moves.
 */
export class FileBrowser {
	open = false;
	query = '';
	index = 0;
	/** The chosen file, once it loads. */
	file: FileContent | undefined;
	/** Why the chosen file did not load. */
	problem: string | undefined;
	/** The table shown when the chosen file is a database. */
	table = 0;
	private files: readonly FileEntry[] = [];
	private token = 0;
	private readonly load: (path: string) => Promise<FileContent>;
	private readonly changed: () => void;

	constructor(load: (path: string) => Promise<FileContent>, changed: () => void) {
		this.load = load;
		this.changed = changed;
	}

	get matches(): FileEntry[] {
		return matchFiles(this.files, this.query);
	}

	get selected(): FileEntry | undefined {
		return this.matches[this.index];
	}

	get total(): number {
		return this.files.length;
	}

	/** Open the panel on these files, with one chosen when the path is known. */
	show(files: readonly FileEntry[], path?: string): void {
		this.files = files;
		this.query = '';
		this.index = Math.max(
			0,
			files.findIndex((file) => file.path === path),
		);
		this.open = true;
		void this.preview();
	}

	hide(): void {
		this.open = false;
		this.token += 1;
		this.changed();
	}

	type(text: string): void {
		this.query += text;
		this.refilter();
	}

	backspace(): void {
		this.query = this.query.slice(0, -1);
		this.refilter();
	}

	clear(): void {
		this.query = '';
		this.refilter();
	}

	/** Show another table of the chosen database. */
	moveTable(step: number): void {
		const count = this.file?.tables?.length ?? 0;
		if (count === 0) return;
		this.table = Math.max(0, Math.min(count - 1, this.table + step));
		this.changed();
	}

	move(step: number): void {
		const last = this.matches.length - 1;
		if (last < 0) return;
		this.index = Math.max(0, Math.min(last, this.index + step));
		void this.preview();
	}

	private refilter(): void {
		this.index = 0;
		void this.preview();
	}

	private async preview(): Promise<void> {
		this.token += 1;
		const mine = this.token;
		const entry = this.selected;
		this.problem = undefined;
		if (!entry) this.file = undefined;
		else if (this.file?.path !== entry.path) await this.read(entry.path, mine);
		this.changed();
	}

	private async read(path: string, mine: number): Promise<void> {
		try {
			const file = await this.load(path);
			if (mine !== this.token) return;
			this.file = file;
			// Start on the first table that holds rows.
			this.table = Math.max(0, file.tables?.findIndex((table) => table.count > 0) ?? 0);
		} catch (error) {
			if (mine !== this.token) return;
			this.file = undefined;
			this.problem = error instanceof Error ? error.message : String(error);
		}
	}
}
