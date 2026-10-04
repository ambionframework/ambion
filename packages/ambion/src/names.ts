/** The unanchored pattern source for a room, participant, workspace, or repository namespace. */
export const NAME_SYNTAX = '[a-z][a-z0-9-]*';

const NAME = new RegExp(`^${NAME_SYNTAX}$`);

/** Whether a value matches the complete name syntax, with no length limit or line terminator. */
export function isName(value: unknown): value is string {
	return typeof value === 'string' && NAME.exec(value)?.[0] === value;
}
