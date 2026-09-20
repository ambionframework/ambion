/**
 * The refusals a host switches on. Every error the room throws on purpose
 * carries one code, and the message stays what it was.
 */

/** Why the room refused a call. A closed set: a host switches on it. */
export type AmbionErrorCode =
	| 'room_stopped'
	| 'room_running'
	| 'no_composition'
	| 'missing_definition'
	| 'visit_ended'
	| 'not_present'
	| 'unknown_participant'
	| 'duplicate_name'
	| 'invalid_name'
	| 'invalid_tool'
	| 'refused'
	| 'stale';

/** An error the room throws on purpose. `code` says which refusal; `message` says why. */
export class AmbionError extends Error {
	override readonly name = 'AmbionError';
	readonly code: AmbionErrorCode;

	constructor(code: AmbionErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
