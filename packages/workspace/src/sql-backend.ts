/**
 * The SQL backend: a shared database beside the shell backend.
 *
 * A workspace always has a shell backend. A SQL backend is optional. When a
 * workspace has one, the `sql` tool runs its statements over this backend,
 * under an owner of its own. The database need not live on the shell's
 * filesystem, and the shell does not reach it.
 *
 * `connect(agent)` gives one agent an environment over the database. A
 * backend with accounts connects as that agent. A backend with one file
 * gives every agent the same handle.
 *
 * This module holds types only, so the root entry loads no database
 * driver. `docs/workspace.md` states the contract.
 */

import type { Context } from '@earendil-works/pi-agent-core';
import type { ResourceBackend, ResourceEnv } from './resource.ts';

/** A value that a SQL database stores. */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** One result row, keyed by column name. */
export type SqlRow = Readonly<Record<string, SqlValue>>;

/**
 * What one `run` gives back. A statement that the database refuses is an
 * `ok: false` outcome with the database's own message. A fault of the
 * connection, or an abort, rejects the promise.
 */
export type SqlOutcome =
	| { readonly ok: true; readonly rows: readonly SqlRow[] }
	| { readonly ok: false; readonly message: string };

/** What one agent reaches through a SQL backend. */
export interface SqlEnv extends ResourceEnv {
	/**
	 * Run one or more statements in order, and give the rows of the last
	 * one. A last statement that returns no rows gives an empty list. The
	 * run stops at the first statement that fails. An aborted
	 * `context.abortSignal` rejects before the first statement runs.
	 */
	run(sql: string, context: Context): Promise<SqlOutcome>;
}

/** A shared database that a workspace opens beside its shell backend. */
export interface SqlBackend extends ResourceBackend<SqlEnv> {
	/**
	 * The name of the database that the `sql` tool reports and the guidance
	 * states: a file path, or an address with no credential in it.
	 */
	readonly database: string;
	/** Guidance about this database: its dialect and its limits. */
	readonly guidance?: string;
}
