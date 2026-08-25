/**
 * Placeholder surface for the Ambion runtime.
 *
 * The framework itself — workspace, agent, task, subscription, timer, and the
 * one invariant that ties them together — lands in a follow-up. This module
 * exists so the package builds, type-checks, packs and publishes, and so the
 * CLI has something real to resolve across the workspace. That round trip is
 * what this scaffold is for.
 */

/**
 * This package's name.
 *
 * Exported so a consumer — today, only the CLI — proves it resolved the
 * built package rather than a stale copy. A test keeps it in step with
 * package.json.
 */
export const PACKAGE_NAME = '@ambionframework/ambion';
