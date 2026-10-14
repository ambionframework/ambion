/**
 * The `compose` tool for Ambion: one tool that joins the other tools of a seat
 * in one call through short code. `composeExtension` makes the seat
 * extension that adds the `compose` tool and the `describe` tool. The runtime
 * that runs the code is a `ComposeRuntime`; `quickjsRuntime` in
 * `@ambionframework/compose/runtime` is the default.
 */
export type {
	ComposeLimits,
	ComposeMacro,
	ComposeOptions,
	ComposeRequest,
	ComposeResult,
	ComposeRuntime,
	ComposeRuntimeInput,
	JsonValue,
	LedgerEntry,
} from './compose.ts';
export { COMPOSE_GUIDANCE } from './compose.ts';
export { composeMacro } from './compose-macros.ts';
export { composeExtension } from './compose-tool.ts';
