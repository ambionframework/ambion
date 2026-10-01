/**
 * The live workflow runs a matrix on the executor kind. It never runs on a pull
 * request, because a live run costs money. The test reads the file as text.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
	fileURLToPath(new URL('../../../.github/workflows/live.yml', import.meta.url)),
	'utf8',
);

describe('the live workflow', () => {
	it('runs on main, on a schedule and on dispatch, and not on a pull request', () => {
		expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]/m);
		expect(workflow).toContain('schedule:');
		expect(workflow).toContain('workflow_dispatch:');
		expect(workflow).not.toContain('pull_request');
	});

	it('runs a matrix on the three executor kinds', () => {
		expect(workflow).toContain('kind: [pi, claude, codex]');
		expect(workflow).toMatch(/AMBION_EXECUTOR: \$\{\{ matrix\.kind \}\}/);
	});

	it('gives each executor kind the secret it reads', () => {
		expect(workflow).toContain("matrix.kind != 'codex' && secrets.ANTHROPIC_API_KEY");
		expect(workflow).toContain("matrix.kind == 'codex' && secrets.CODEX_API_KEY");
	});

	it('skips the steps of an executor kind whose secret is empty', () => {
		expect(workflow).toContain("if: steps.key.outputs.present == 'true'");
		expect(workflow).not.toMatch(/exit 1/);
	});
});
