/**
 * The runtime of the `compose` tool. `quickjsRuntime` runs the code of a
 * compose call with no ambient authority, and it passes `composeRuntimeConformance`
 * from `@ambionframework/ambion/conformance`.
 */
export { type QuickjsOptions, quickjsRuntime } from './quickjs.ts';

export const PACKAGE_NAME = '@ambionframework/compose';
