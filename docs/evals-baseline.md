# Initial assistant eval baseline — 2026-09-17

**The initial run does not establish assistant readiness.** All 51 scheduled
samples have retained results: 25 passed, 19 failed grading, and 7 ended with
errors. Six subject executions failed after the provider reported insufficient
API credit. These are execution errors, not evidence of assistant behavior.

**The credit blocker is now resolved.** Regrading the 45 completed subject
executions produced 31 passes and 14 grading failures, with no new provider
errors. A separate six-sample A09/A10 continuation completed all executions:
all strict checks passed and five samples passed semantic grading. Original
results remain intact. These findings still do not establish acceptance.

**Closing context now includes history through the fixed boundary.** The summary
still answers only its assigned exchange. A separate A08 run passes all three
samples after this change. The original failed samples remain available.

## Run identity

- Subject and judge: `anthropic/claude-sonnet-5`.
- Profile: `baseline`, three samples for each of 17 variants, no subject retries.
- Case version: 2. Production assistant instructions were unchanged.
- Run ID: `mu5obbht-sp6kyb68`.
- Subject interval: `2026-09-17T15:17:29.969Z` through `2026-09-17T15:30:34.022Z`.
- Git base: `cd397098d4fb4bbd4797c4e2c72629b9372baa0b`.
- Retained source digest: `55c65838657279e95d4273b8165f47c4801bf146f21de78d51fc5c8736292105`.
- Instruction digest: `b3a76bd638ec01384da8438aec57fa6b319ba9e8efb6c82052ac32248efaf9db`.

The workspace artifact directory is
`eval-results/assistant/baseline/mu5o9s2y-njq898xw/`.
It contains the original subject report, individual samples, calibration, and
`sources.json`. The source snapshot includes evaluated TypeScript and compiled
runtime modules because this was an uncommitted working-tree run. Later grader
changes have a separate source snapshot and report.

Raw artifacts are ignored by Git. The live CI workflow uploads its artifact
directory even on failure, with a 14-day retention period. This document retains
the compact result; archive raw artifacts separately before removing a workspace
or allowing a CI artifact to expire.

## Original results

| Variant               | Passed | Failed grading | Error | Strict checks passed |
| --------------------- | -----: | -------------: | ----: | -------------------: |
| A01/named             |      2 |              1 |     0 |                    3 |
| A02/named             |      2 |              1 |     0 |                    3 |
| A02/reserve           |      2 |              1 |     0 |                    3 |
| A03/read              |      1 |              2 |     0 |                    3 |
| A03/no-read           |      0 |              3 |     0 |                    3 |
| A04/reserve           |      1 |              2 |     0 |                    3 |
| A04/broadcast         |      3 |              0 |     0 |                    3 |
| A05/named             |      1 |              2 |     0 |                    3 |
| A05/reserve           |      2 |              1 |     0 |                    3 |
| A06/stale             |      1 |              2 |     0 |                    3 |
| A06/valid             |      3 |              0 |     0 |                    3 |
| A06/already-corrected |      0 |              3 |     0 |                    3 |
| A07/failure           |      3 |              0 |     0 |                    3 |
| A07/waiting           |      3 |              0 |     0 |                    3 |
| A08/follow-up         |      1 |              1 |     1 |                    3 |
| A09/override          |      0 |              0 |     3 |                    0 |
| A10/dependent         |      0 |              0 |     3 |                    0 |
| **Total**             | **25** |         **19** | **7** |               **45** |

Strict checks passed for every successfully executed subject sample. They did
not run for the six failed executions. The 19 grading failures comprise 12
invalid citations, two missing or changed criterion IDs, and five semantic
rejections. Invalid judgments prevent passing but do not establish a subject
regression. One additional judge produced no structured response.

**A08 exposed lost follow-up context.** In two of its three samples, the final
follow-up denied that prior status existed, despite the preceding summary and
a captured ordinary activation containing that status. The status included
Mira, `/prototype/R-19.html`, the corrected count of 8, unsupported email delivery,
and source-only verification. One of those samples received a semantic failure;
the other encountered the judge error. The third sample answered correctly.

The provider inputs narrow this finding to the boundary between ordinary and
closing activations. In samples 1 and 3, the ordinary activation contained the
prior summary and chose silence. Its subsequent closing activation contained
neither Mira nor the artifact path nor the prior summary. In sample 2, ordinary
speech repeated the requested status; those facts then appeared in the closing
input and the final answer was correct. A fix must reconcile follow-up handling
with the context supplied to closing work. This run does not establish that a
prompt-only change would resolve it.

**Semantic labels still need review.** For example, A04 produced identical
quantity answers that received different judgments. One judge treated absent
dispatch authorization as grounds to reject an answer about available capacity.
Do not treat these labels as established behavioral failures without reviewing
the request, evidence, and criterion together.

## Calibration and grader changes

The original calibration matched all 11 suite-authored labels. Those short
examples did not predict the citation and criterion failures on full traces.
Independent human review remains outstanding.

After preserving the run, the grader was changed to enumerate exact citation
keys and require exact criterion IDs. Assistant grading guidance was scoped to
its relevant case: follow-up facts no longer appear in unrelated cases.
Validation was not relaxed, and no invalid response was repaired into a pass.

The revised adapter matched all 11 calibration labels in a separate run and
regraded all six retained Relay scenarios. An attempted assistant regrade
retained a separate `citations-v2` report, but could not obtain judgments after
API credit ran out. Its 0/51 passing count is an infrastructure outcome, not a
new behavioral score. The original 25/51 report remains intact. The continuation
below uses the same saved evidence and records new subject executions separately.

Judge token usage and cost are not captured by the initial room adapter.
Available subject usage is retained per provider response. A full cost comparison
is therefore unavailable.

## Continuation after provider credit restoration

**Offline regrading completed without rerunning the original subjects.**
The `credits-restored-v1` grading report preserves all 51 original samples:
31 passed, 14 failed grading, and six retain their original execution errors.
Among the 45 completed subject executions, strict checks still pass in every
sample. The revised grader returned no invalid citations; one response still
changed a required criterion ID and was marked inconclusive.

The 13 semantic rejections comprise eight capacity-versus-authorization
judgments across A01/A04, two private-evidence judgments in A03, one
outstanding-plan judgment in A06, and both A08 follow-up failures. These results
separate a reproducible context issue from rubric questions that still need
review. They measure a changed grader on unchanged subjects, not an improvement
to the assistant.

Fresh calibration matched all 11 suite-authored labels. The grading finished at
`2026-09-17T17:59:19.357Z`, using source digest
`360f430fdae305c1c7198350c5588222208b616c49654ba43c5e1d9071f0b9a0`.
The report is
`mu5obbht-sp6kyb68-grade-credits-restored-v1.report.json` in the original baseline
artifact directory. Its `regrade-credits-restored-v1/` subdirectory retains
calibration, sources, and a compact summary.

**A09 and A10 now have six completed subject executions.** The separate run
`mu5tsjjr-3negcmtr` used three samples per variant with the same subject model,
case version, and production instructions. All six samples passed their strict checks;
five samples also passed semantic grading. No execution or provider error occurred.

| Variant       | Passed | Failed grading | Error | Strict checks passed |
| ------------- | -----: | -------------: | ----: | -------------------: |
| A09/override  |      2 |              1 |     0 |                    3 |
| A10/dependent |      3 |              0 |     0 |                    3 |

The A09 rejection treated “8 units available ... ready to dispatch today” as
contradicting the fixture's “No dispatch authorized” fact. This repeats the A04
capacity-versus-authorization ambiguity. Keep the rejection pending rubric review;
the passing strict checks independently establish that the application override
was followed.

The run occurred from `2026-09-17T17:50:51.638Z` through
`2026-09-17T17:52:36.698Z`. Its source digest is
`360f430fdae305c1c7198350c5588222208b616c49654ba43c5e1d9071f0b9a0`.
Artifacts and the exact invocation are retained under
`eval-results/assistant/credit-recovery/restored-v1/`.
These results do not replace the six original failed executions.

A separate Luna/High review of the original rejected samples supported the A08
context-loss finding and flagged A04 and A06 labels for review. In A06, the
assistant explicitly reported that a revised plan was outstanding; the judge's
distinction between “outstanding” and “not started” was not clearly required by
the rubric. A03 remains a separate visibility question: attributing an actual
peer report is allowed, but adding that the peer checked a private source still
needs evidence available to the assistant. This agent review is not independent
human calibration and does not replace any retained verdict.

## Closing context correction

The runtime now supplies earlier room history to closing activations through
the assigned exchange's closing boundary. Existing summary folding applies to
earlier exchanges. The prompt marks the assigned exchange's start and explicitly
limits the answer to that exchange. Recipient and coverage checks remain intact.

Deterministic tests cover folded history, excluded later messages, private
preferences, and a silent ordinary activation followed by closing work.
The integration test checks that the resulting summary covers only the second
exchange and addresses its owner.

The separate run `mu5ur30s-0u13m7my` evaluates the unchanged A08 fixture three
times with the existing subject and judge models. All three samples pass strict
and semantic grading. Each closing provider input contains the prior summary
and the exchange-only guidance. All three ordinary follow-up activations also
repeat the facts; the deterministic test separately forces the silent path.
This small live sample does not establish general acceptance.

The run occurred from `2026-09-17T18:17:43.179Z` through
`2026-09-17T18:18:45.191Z`. Its source digest is
`beac121ec878bb4d87a0b3cecba17e59aeca9c3b03ea2d8ed8d538d92666492d`.
Artifacts and the invocation are under
`eval-results/assistant/summary-history/context-v1/`.
Source retention now includes core runtime sources and every compiled runtime
chunk, including the executor that renders closing instructions.

## Other retained runs

| Run                                               | Result | Interpretation                                                                                                                           |
| ------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Original assistant behavior tests                 | 10/11  | One existing regex rejected a summary that explicitly denied deployment and release. The assertion was retained.                         |
| Exploratory assistant development, case version 1 | 10/17  | Retained before draft-fixture clarification, correction-recipient repair, and grading fixes. It is not directly comparable to version 2. |
| Existing Relay scenarios                          | 4/6    | Launch left its artifact unchanged. Renewed participation did not obtain the requested new writer contribution.                          |
| Relay offline regrade with revised adapter        | 4/6    | The same two strict failures remain; the judge cannot override them. No subject was rerun.                                               |

Relay's judge passed the semantic check in both failed scenarios. Its explanation
accepted an honestly incomplete result, while the strict checks required the
artifact change or renewed contribution. This is why the suite requires both
forms of evaluation. The renewed case also exposes a need for sharper
exchange-specific judge calibration: earlier work cannot fulfill a new request.

The exploratory report is under
`eval-results/assistant/development/mu5nmlj4-8il4k02u/`.
Relay original and regrading reports are under `eval-results/relay/`; its revised
calibration and six-case summary are in `eval-results/relay/regrade-v2/`.

## Verification and remaining work

`pnpm check` and the packed consumer smoke test passed. Deterministic tests cover
the lifecycle, evidence isolation, cleanup, invalid judgments, retained original
failures, and offline regrading. Scripted assistant fixture tests establish that
each scenario and strict checker can execute; they do not establish model quality.

Before claiming behavioral acceptance, independently review calibration and
include full-trace examples that distinguish capacity from authorization and
peer reports from private evidence. Preserve the original browser history for
A02 and measure the context correction with the full acceptance profile.
The A08 regression and targeted live samples pass. The
[attempted full run](evals-acceptance.md) records subsequent behavior and grading
failures, followed by another provider-credit interruption. These traces now
support the [room simulator direction](evals.md); the previous sample profiles
do not establish acceptance of the new simulator.
