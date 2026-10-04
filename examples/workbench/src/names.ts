import { isName } from '@ambionframework/ambion/names';

/** Whether a room name matches the shared syntax and the workbench limit. */
export function isRoomName(value: unknown): value is string {
	return isName(value) && value.length <= 48;
}

/** The longest goal a room takes, in characters. */
export const MAX_GOAL = 2_000;
