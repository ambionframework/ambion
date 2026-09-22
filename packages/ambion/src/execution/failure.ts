/**
 * Whether an executor failure is permanent or transient, from the text a
 * harness matched and an HTTP status when the provider gave one.
 */

import type { FailureCause } from '../types.ts';

/** HTTP statuses a retry cannot fix: a bad request and the billing and authentication refusals. */
export const PERMANENT_STATUS: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 405, 422]);

/**
 * Whether a failure is permanent or transient. `permanent` is the text a
 * harness matches for a refusal a retry cannot clear; each harness brings
 * its own, because each provider names a refusal in its own words.
 * `status` beats an unmatched text: a permanent status from `PERMANENT_STATUS`
 * is permanent even when the text names nothing. Every other failure is
 * transient, so an uncertain failure retries rather than gives up.
 */
export function classifyCause(input: {
	readonly text?: string;
	readonly status?: number | null;
	readonly permanent: RegExp;
}): FailureCause {
	if (input.text !== undefined && input.permanent.test(input.text)) return 'permanent';
	const status = input.status;
	return status !== undefined && status !== null && PERMANENT_STATUS.has(status)
		? 'permanent'
		: 'transient';
}
