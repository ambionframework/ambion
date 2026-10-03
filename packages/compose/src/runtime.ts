/**
 * The runtimes of the `compose` tool. Each one runs the code of a compose
 * call with no ambient authority, and each one passes `composeRuntimeConformance`
 * from `@ambionframework/ambion/conformance`.
 */
export { type ProcessOptions, processRuntime, type SpawnChild } from './process.ts';
export { type QuickjsOptions, quickjsRuntime } from './quickjs.ts';

export const PACKAGE_NAME = '@ambionframework/compose';
