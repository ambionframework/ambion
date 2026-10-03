/**
 * The evaluators of the `compose` tool. Each one runs the code of a compose
 * call with no ambient authority, and each one passes `evaluatorConformance`
 * from `@ambionframework/ambion/conformance`.
 */
export { type ProcessOptions, processEvaluator, type SpawnChild } from './process.ts';
export { type QuickjsOptions, quickjsEvaluator } from './quickjs.ts';

export const PACKAGE_NAME = '@ambionframework/compose';
