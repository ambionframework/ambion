import type { Session as PiSession } from '@earendil-works/pi-agent-core';

/** Opens one Pi transcript session by id. */
export interface SessionOpener {
	open(id: string, parentId?: string): Promise<PiSession>;
}
