/**
 * A `SqlBackend` over one `node:sqlite` handle, for tests. The package ships
 * no SQL backend: this one proves the interface, the conformance cases, and
 * the `sql` tool over a backend. It is not a sandbox: `ATTACH` reaches the
 * host filesystem.
 */
import { DatabaseSync } from 'node:sqlite';
import type { ConformanceCase } from '../../src/conformance.ts';
import type { SqlBackend, SqlEnv, SqlOutcome, SqlRow } from '../../src/sql-backend.ts';

export type { ConformanceCase };

/** A test backend, and how many times the workspace disposed it. */
export interface TestSqlBackend extends SqlBackend {
	readonly disposals: () => number;
	/** The agents that connected, in order. */
	readonly agents: readonly string[];
}

/** True when `text` holds only whitespace and comments. */
function blank(text: string): boolean {
	return text.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, '').trim() === '';
}

/**
 * Run each statement of `sql` in order, and keep the rows of the last one.
 * `prepare` compiles the first statement, and `sourceSQL` gives its text, so
 * the rest of the input starts after it.
 */
function runAll(db: DatabaseSync, sql: string): SqlOutcome {
	let rest = sql;
	let rows: SqlRow[] = [];
	try {
		while (!blank(rest)) {
			const statement = db.prepare(rest);
			const returnsRows = statement.columns().length > 0;
			rows = returnsRows ? (statement.all() as SqlRow[]) : [];
			if (!returnsRows) statement.run();
			rest = rest.slice(statement.sourceSQL.length);
		}
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true, rows };
}

export function sqliteTestBackend(location = ':memory:'): TestSqlBackend {
	const db = new DatabaseSync(location);
	let disposed = 0;
	let open = true;
	const agents: string[] = [];
	const env: SqlEnv = {
		run: async (sql, context) => {
			if (context.abortSignal?.aborted) throw new Error('Operation aborted.');
			return runAll(db, sql);
		},
		cleanup: async () => undefined,
	};
	return {
		database: location,
		guidance:
			'This is SQLite: dates are functions, || joins text, and a column type is an affinity.',
		connect: async (agent) => {
			agents.push(agent.name);
			return env;
		},
		dispose: async () => {
			disposed += 1;
			if (open) db.close();
			open = false;
		},
		disposals: () => disposed,
		agents,
	};
}
