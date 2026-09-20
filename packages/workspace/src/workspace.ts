import type { Room, ToolBundle } from '@ambionframework/ambion';
import { type AuditLog, type AuditLogOptions, auditGuidance, openAuditLog } from './audit.ts';
import type { WorkspaceBackend, WorkspaceEnv } from './backend.ts';
import {
	mirrorRoom,
	ROOM_MIRROR_GUIDANCE,
	type RoomMirror,
	type RoomMirrorOptions,
} from './mirror.ts';
import { openResource, type WorkspaceAgent, type WorkspaceResource } from './resource.ts';
import { bindTools } from './tools.ts';

/** A workspace resource with an ordinary Ambion tool bundle. */
export interface Workspace extends WorkspaceResource<WorkspaceEnv> {
	/** Return the backend tools and optional model guidance as one stable bundle. */
	tools(): ToolBundle;
	/**
	 * Start mirroring `room`'s messages to `/rooms/<room.name>/messages.jsonl`
	 * on this workspace. Call once the room has started.
	 */
	mirror(room: Room, options?: RoomMirrorOptions): Promise<RoomMirror>;
}

/** The backend's own guidance, with a note about the audit log appended when one is set. */
function guidanceFor(
	backendGuidance: string | undefined,
	audit: AuditLog | undefined,
): string | undefined {
	const notes = [backendGuidance, audit && auditGuidance(audit), ROOM_MIRROR_GUIDANCE].filter(
		(note): note is string => note !== undefined && note !== '',
	);
	return notes.length === 0 ? undefined : notes.join('\n\n');
}

/**
 * Open one workspace resource and bind its backend tools to that owner. Set
 * `audit` to record every bound tool call as one JSONL line on the
 * workspace's own filesystem, rotated once the file passes its configured
 * size. Tool guidance then tells every agent the log exists and where to
 * read it, and always names the `/rooms` convention `mirror()` writes to.
 */
export function openWorkspace(options: {
	name: string;
	backend: WorkspaceBackend;
	audit?: AuditLogOptions;
}): Workspace {
	const resource = openResource<WorkspaceEnv>(options);
	const audit = options.audit === undefined ? undefined : openAuditLog(options.audit);
	const toolBundle = bindTools(
		options.backend.tools,
		resource.use,
		guidanceFor(options.backend.guidance, audit),
		audit,
	);
	const tools = (): ToolBundle => toolBundle;
	// The workspace's own write identity for a mirror: one agent it owns,
	// so a caller names only the room.
	const hostAgent: WorkspaceAgent = {
		name: `${options.name}-host`,
		identity: 'The workspace, writing a room record it mirrors.',
	};
	const mirror = (room: Room, mirrorOptions?: RoomMirrorOptions): Promise<RoomMirror> =>
		mirrorRoom(room, resource, hostAgent, mirrorOptions);
	return Object.freeze({ ...resource, tools, mirror });
}
