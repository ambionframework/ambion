import type { ToolBundle } from '@ambionframework/ambion';
import type { WorkspaceBackend } from './backend.ts';
import { openResource, type WorkspaceResource } from './resource.ts';
import { bindTools } from './tools.ts';

/** A workspace resource with an ordinary Ambion tool bundle. */
export interface Workspace extends WorkspaceResource {
	/** Return the backend tools and optional model guidance as one stable bundle. */
	tools(): ToolBundle;
}

/** Open one workspace resource and bind its backend tools to that owner. */
export function openWorkspace(options: { name: string; backend: WorkspaceBackend }): Workspace {
	const resource = openResource(options);
	const toolBundle = bindTools(options.backend.tools, resource.use, options.backend.guidance);
	const tools = (): ToolBundle => toolBundle;
	return Object.freeze({ ...resource, tools });
}
