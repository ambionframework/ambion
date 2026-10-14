/**
 * The runtime of the `compose` tool. `quickjsRuntime` runs the code of a
 * compose call with no ambient authority, and it passes `composeRuntimeConformance`
 * from `@ambionframework/compose/conformance`.
 */
export { type QuickjsOptions, quickjsRuntime } from './quickjs.ts';
