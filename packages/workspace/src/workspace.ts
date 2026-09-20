import type { ToolBundle } from '@ambionframework/ambion';
import type { AuditLogOptions } from './audit.ts';
import { openAuditLog } from './audit.ts';
import type { WorkspaceBackend } from './backend.ts';
import { openResource, type WorkspaceResource } from './resource.ts';
import { bindTools } from './tools.ts';

/** A workspace resource with an ordinary Ambion tool bundle. */
export interface Workspace extends WorkspaceResource {
	/** Return the backend tools and optional model guidance as one stable bundle. */
	tools(): ToolBundle;
}

/**
 * Open one workspace resource and bind its backend tools to that owner. Set
 * `audit` to record every bound tool call as one JSONL line, rotated once
 * the file passes its configured size.
 */
export function openWorkspace(options: {
	name: string;
	backend: WorkspaceBackend;
	audit?: AuditLogOptions;
}): Workspace {
	const resource = openResource(options);
	const audit = options.audit === undefined ? undefined : openAuditLog(options.audit);
	const toolBundle = bindTools(
		options.backend.tools,
		resource.use,
		options.backend.guidance,
		audit,
	);
	const tools = (): ToolBundle => toolBundle;
	return Object.freeze({ ...resource, tools });
}
