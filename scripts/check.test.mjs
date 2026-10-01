import { strict as assert } from 'node:assert';
import test from 'node:test';
import { clip, failedTasks, findings, selectSteps } from './check-lib.mjs';

const dirs = {
	'@ambionframework/journal': 'packages/journal',
	'@ambionframework/just-bash': 'packages/just-bash',
};

/** A failed `turbo run check:types`, as turbo prints it with `errors-only`. */
const types = `
   • turbo 2.11.5
   • Packages in scope: @ambionframework/journal, @ambionframework/just-bash
   • Running check:types in 2 packages
   • Remote caching disabled

@ambionframework/journal:check:types: cache miss, executing 25a18be12c1f6a2d
@ambionframework/journal:check:types:
@ambionframework/journal:check:types: > @ambionframework/journal@0.4.0 check:types /home/user/ambion/packages/journal
@ambionframework/journal:check:types: > tsc -p tsconfig.check.json --noEmit
@ambionframework/journal:check:types:
@ambionframework/journal:check:types: src/index.ts(50,14): error TS2322: Type 'string' is not assignable to type 'number'.
@ambionframework/journal:check:types:  ELIFECYCLE  Command failed with exit code 1.
@ambionframework/journal#check:types:  WARNING  command finished with error, but continuing...
@ambionframework/journal#check:types:  ERROR  command (/home/user/ambion/packages/journal) /bin/pnpm run check:types exited (1)

 Tasks:    21 successful, 23 total
Cached:    17 cached, 23 total
  Time:    6.061s
Failed:    @ambionframework/journal#check:types, @ambionframework/just-bash#check:types

 ERROR  run failed: command  exited (1)
`;

/** A failed Vitest run under turbo, with a frame inside a dependency. */
const vitest = `
@ambionframework/just-bash:test:  RUN  v4.1.11 /home/user/ambion/packages/just-bash
@ambionframework/just-bash:test:  ✓ test/drive.test.ts (4 tests) 120ms
@ambionframework/just-bash:test: ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
@ambionframework/just-bash:test:  FAIL  test/just-bash.test.ts > the adapter > ends a change
@ambionframework/just-bash:test: Error: Test timed out in 20000ms.
@ambionframework/just-bash:test:  ❯ test/just-bash.test.ts:167:2
@ambionframework/just-bash:test:  ❯ DirectoryFs.mkdir ../../node_modules/.pnpm/just-bash@3.4.2/node_modules/just-bash/dist/index.js:804:20
@ambionframework/just-bash:test: ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
@ambionframework/just-bash:test:    Start at  16:35:12
@ambionframework/just-bash:test:    Duration  62.14s (transform 14.48s)
`;

test('a failed turbo task keeps its findings, under one header, with paths from the root', () => {
	assert.deepEqual(findings(types, dirs), [
		'── packages/journal check:types',
		"packages/journal/src/index.ts:50:14: error TS2322: Type 'string' is not assignable to type 'number'.",
	]);
	assert.deepEqual(findings(vitest, dirs), [
		'── packages/just-bash test',
		'⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
		' FAIL  packages/just-bash/test/just-bash.test.ts > the adapter > ends a change',
		'Error: Test timed out in 20000ms.',
		' ❯ packages/just-bash/test/just-bash.test.ts:167:2',
	]);
});

test('the failed tasks come from the summary of the run, without the scope', () => {
	assert.deepEqual(failedTasks(types), ['journal#check:types', 'just-bash#check:types']);
	assert.deepEqual(failedTasks('ok'), []);
});

test('a long finding keeps its head and names the log', () => {
	const lines = ['a', 'b', 'c'];
	assert.deepEqual(clip(lines, 3, 'x.log'), lines);
	assert.deepEqual(clip(lines, 2, 'x.log'), ['a', 'b', '… 1 more lines in x.log']);
});

test('a selection keeps the report order and refuses a name that is no step', () => {
	assert.equal(selectSteps([]).length, 8);
	assert.deepEqual(
		selectSteps(['test', 'lint']).map((step) => step.name),
		['lint', 'test'],
	);
	assert.throws(() => selectSteps(['lnit']), /unknown step: lnit\. Steps: format lint/);
});
