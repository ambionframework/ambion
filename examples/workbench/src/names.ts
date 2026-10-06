import { isName } from '@ambionframework/ambion/names';
import { NAME_LIMIT } from '@ambionframework/canvas';

/** Whether a room name matches the shared syntax and the workbench limit. */
export function isRoomName(value: unknown): value is string {
	return isName(value) && value.length <= NAME_LIMIT;
}

/** The longest goal a room takes, in characters. */
export const MAX_GOAL = 2_000;
