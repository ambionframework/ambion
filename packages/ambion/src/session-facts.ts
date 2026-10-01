/** What a vendor session reports about how it opened. */

/**
 * The facts of the `session` step. An executor that can read them records
 * one step for each session it opens. `auth` names the source of the
 * credential and never holds it. `tools` holds the room tools by their plain
 * names.
 */
export interface SessionFacts {
	name: string;
	version?: string;
	model?: string;
	cwd?: string;
	session?: string;
	auth?: string;
	permissionMode?: string;
	tools: string[];
	servers: { name: string; status: string }[];
}
