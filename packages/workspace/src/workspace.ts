import type { Room, ToolBundle } from '@ambionframework/ambion';
import { type AuditLog, type AuditLogOptions, auditGuidance, openAuditLog } from './audit.ts';
import type { WorkspaceBackend, WorkspaceEnv } from './backend.ts';
import {
	mirrorRoom,
	type RoomMirror,
	type RoomMirrorOptions,
	roomMirrorGuidance,
} from './mirror.ts';
import { openResource, type WorkspaceAgent, type WorkspaceResource } from './resource.ts';
import { bindTools } from './tools.ts';

/** A workspace resource with an ordinary Ambion tool bundle. */
export interface Workspace extends WorkspaceResource<WorkspaceEnv> {
	/** Return the backend tools and optional model guidance as one stable bundle. */
	tools(): ToolBundle;
	/**
	 * The agent identity `mirror()` writes as: `<name>-host`, one agent this
	 * workspace owns. A backend with real accounts can give it credentials.
	 */
	readonly host: WorkspaceAgent;
	/**
	 * Start mirroring `room`'s messages under the backend's layout, at
	 * `<layout.rooms>/<room.name>/messages.jsonl`. Call once the room has
	 * started.
	 */
	mirror(room: Room, options?: RoomMirrorOptions): Promise<RoomMirror>;
}

/** The backend's own guidance, with a note about the audit log appended when one is set. */
function guidanceFor(
	backendGuidance: string | undefined,
	audit: AuditLog | undefined,
	roomsRoot: string,
): string | undefined {
	const notes = [
		backendGuidance,
		audit && auditGuidance(audit),
		roomMirrorGuidance(roomsRoot),
	].filter((note): note is string => note !== undefined && note !== '');
	return notes.length === 0 ? undefined : notes.join('\n\n');
}

/**
 * Open one workspace resource and bind its backend tools to that owner. The
 * backend's `layout` names where the audit log, the shared database, and the
 * room mirrors live. Set `audit.path` to record every bound tool call at a
 * path of your own; the default is `layout.audit`. Tool guidance then tells
 * every agent the log exists and where to read it, and always names the room
 * mirror convention at `layout.rooms`.
 */
export function openWorkspace(options: {
	name: string;
	backend: WorkspaceBackend;
	audit?: AuditLogOptions;
}): Workspace {
	const resource = openResource<WorkspaceEnv>(options);
	const layout = options.backend.layout;
	const audit =
		options.audit === undefined
			? undefined
			: openAuditLog({ ...options.audit, path: options.audit.path ?? layout.audit });
	const toolBundle = bindTools(
		options.backend.tools,
		resource.use,
		guidanceFor(options.backend.guidance, audit, layout.rooms),
		audit,
	);
	const tools = (): ToolBundle => toolBundle;
	// The workspace's own name for a mirror: one agent it owns, so a caller
	// names only the room.
	const host: WorkspaceAgent = { name: `${options.name}-host` };
	const mirror = (room: Room, mirrorOptions?: RoomMirrorOptions): Promise<RoomMirror> =>
		mirrorRoom(room, resource, host, layout.rooms, mirrorOptions);
	return Object.freeze({ ...resource, tools, host, mirror });
}
