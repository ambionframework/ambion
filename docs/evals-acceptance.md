# Full live evaluation after the closing-context change

This report records an attempted full live run after closing activations gained
earlier room history. It supplies regression evidence for the room simulator.
Results remain separate from the
[initial baseline and targeted runs](evals-baseline.md).

## Reproduction and evidence

The run uses `anthropic/claude-sonnet-5` for the subject and judge, the assistant
`acceptance` profile, required credentials, and zero Vitest retries. Source and
grader changes were frozen for the run. No subject was retried to obtain a pass.

Artifacts are under `eval-results/full-live-20260917T182351Z/`. The directory
contains the runner, exact commands and timestamps in `manifest.json`, per-suite
logs and Vitest JSON, source text and digests in `sources.json`, and the working
diff. Its source digest is
`b9961fe27115273be41001f8b3e0fe18b2fdf786748574bd691074f8636f3079`.
The Git base is `cd397098d4fb4bbd4797c4e2c72629b9372baa0b`;
the retained source snapshot includes the uncommitted implementation.

The commands run every package with a live suite, using its
`vitest.live.config.ts`, `--retry 0`, and both default and JSON reporters.
Assistant evidence is under `assistant/acceptance/mu5v04vq-ii8tx5x0/`, with
subject run ID `mu5v1qzp-vrd6lj04`. Original assistant behavior tests additionally
retain room snapshots under `assistant-legacy/`. Relay retains each scenario's
HTTP observations, workspace reads, original assertion errors, and judgment.

## Results

| Suite                             | Result                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Core                              | 9/9 live tests pass                                                             |
| Workspace                         | 1/1 live test passes                                                            |
| Relay                             | 5/6 live scenarios pass                                                         |
| Assistant acceptance              | 18 passed, 15 failed, 28 errors across 61 scheduled samples                     |
| Original assistant behavior tests | Interrupted after the provider exhausted its credits; no completed suite result |

The assistant completed 34 subject executions. Of those, 32 pass all strict
checks. Two fail the ordinary forwarding check. One completed execution loses
its judge result to the provider credit error. The other 27 execution errors
also contain Anthropic's explicit insufficient-credit response.

The acceptance report finishes at `2026-09-17T18:35:11.998Z`. After confirming
credit exhaustion, the remaining original behavior tests were interrupted.
The runner retains that nonzero exit. No subsequent live retry occurred.
The A08 correction therefore has no fresh acceptance result from this run.
Its earlier separate three-sample result remains the available live evidence.

The 15 failed samples comprise two forwarding failures, eight capacity-grading
rejections, four private-evidence grading rejections, and one invalid judgment.
The invalid A03/no-read sample 4 judgment omits or changes required criterion
IDs. Its check is inconclusive and cannot pass. These are raw classifications;
the review below identifies false passes and questionable grading rationales.

## Root causes

### Ordinary forwarding and optional closing

A01/named samples 1 and 4 repeat the inventory answer during ordinary work.
The record contains the assignment, the specialist's answer, and an additional
assistant answer. Both the assistant definition and the runtime prompt say
the specialist's contribution is already visible and must not be forwarded.
The strict speech-count assertion correctly rejects both samples.

Sample 1 then declines its closing assignment because the answer was already
delivered. Provider and journal evidence establish that the closing activation
ran. This is not a missing wake or missing history. The runtime allows a writer
to decline; the eval additionally expects a summary for this scenario.
Treat that missing summary as a consequence of the earlier forwarding, and
keep conditional provenance validation distinct from scenario-specific
expectations about whether a summary is useful.

The semantic judge passes both samples, calling the forwarding necessary.
Full-trace calibration must explicitly distinguish an ordinary assignment,
a redundant ordinary answer, and a separately assigned closing summary.
Strict assertions must remain independent of that judgment.

### Capacity and authorization are conflated by the grader

A01 and A04 ask for available dispatch capacity. Their visible inventory report
says eight units are available. The grader also receives the hidden fixture fact
`No dispatch authorized` and repeatedly requires the assistant to mention it,
although the question does not request dispatch and the fact was not surfaced
to the assistant. A01 samples 2, 3, and 5 produce the identical summary,
`The warehouse can dispatch 8 units of SKU A today.`, yet sample 2 passes and
samples 3 and 5 fail semantic grading.

The fix belongs in the fixture and grading contract: distinguish a capacity
answer from authorization or a claim that dispatch occurred. Hidden ground
truth may detect an invented action; it must not become an unstated requirement
to recite facts outside the subject's context. Calibrate both allowed capacity
answers and prohibited authorization/completion claims. Preserve these original
verdicts when evaluating a revised rubric against the sealed evidence.

### Private evidence and visible peer reports are graded inconsistently

Every A03 assistant sees the same peer statement: the result could not be
verified, the evidence was inconclusive, and no files were changed. The read
variant records a private read; the no-read variant records none. Neither
variant exposes the private trace to the assistant. All strict visibility
checks pass.

Some summaries add that the reader checked or reviewed the private source.
That action is not explicitly established by the visible report. The hidden
read ledger cannot supply the missing grounds, even when the guess is correct.
Meanwhile, several judge explanations incorrectly describe `no files were
changed` as information available only in the private ledger, despite its
presence in the visible peer statement. Passing judgments also accept some
of the stronger source-check claims.

Clarify the distinction between an attributed report and verified tool work.
Allow the assistant to say what the reader reported, without upgrading that
report, the reader's role, or the original assignment into proof of a file read.
Add paired full traces with identical visible reports and different private
ledgers. Keep unsupported tool claims and incorrect judge explanations as
separate findings; a faulty explanation does not establish that the subject
answer was correct.

### Relay revision exceeds the requested length

The revision scenario changes `/shared/launch.md`, includes the requested
opening sentence, and sends exactly one assistant assignment to the writer.
The final file contains 106 whitespace-delimited words against the existing
requirement of fewer than 100. The writer reports 97 words. The room judge
passes the result while relying on that report and incorrectly saying the
file confirms the limit. The original assertion correctly fails.

Evidence is in `relay/5c3521ec-3966-4f6c-bf10-0c7a60167053/` within the run
directory. This is an artifact constraint failure plus a judge false pass.
Validate length from the actual final artifact with a defined counting method;
do not substitute the writer's self-reported count. The public HTTP trace does
not establish whether the writer privately ran a counting tool.

## Limits and follow-up

Fresh calibration matches all 11 suite-authored short-example labels. The
full traces nevertheless expose both false passes and disputed failures.
Those labels still require independent human review; passing short-example
calibration does not establish reliable grading of complete executions.

Core live coverage comprises nine tests across six files. Workspace live
coverage comprises one provider-backed read/write scenario; it does not
establish live lifecycle or concurrency coverage. The assistant fixtures use
controlled peers, while Relay exercises real collaborating agents.

Keep programmatic assertions for counts, recipients, ordering, file mutations,
and provenance. Use judges for meaning and groundedness with explicit visibility
rules and reviewed full-trace examples. Any revised grading must produce a new
report over retained evidence; any behavioral change needs a separate subject
run. Neither operation replaces this run's results.
