# Assistant acceptance review

Reviewed on 2026-09-16 using `anthropic/claude-sonnet-5`, with Luna/High
reviewing the activation prompts and the primary agent checking architecture,
provider evaluations, and the Relay browser.

**Behavioral acceptance remains incomplete.** The package and room API are
implemented, but live behavior still violates parts of the documented contract.
The project owner accepted this baseline for merge and deferred reliability
improvements to the work defining an evals package. The failures below remain
part of that follow-up; this decision does not turn them into passing results.

## Prompt contexts

| Context                                      | Expected contract                                                                                               | Review evidence                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary activation with reserve specialist  | Seat the specialist; the existing request supplies direction without a duplicate message                        | Assembled-context tests check the request, constraints, goal, and membership tools; live Relay results remain inconsistent                  |
| Ordinary activation with named specialist    | One directed `say`, including applicable constraints                                                            | Three fixed live samples; one still forwarded the specialist result to the human                                                            |
| Broadcast specialist                         | Let the specialist work without repeating the request                                                           | Live routing sample passed                                                                                                                  |
| Specialist result arriving during activation | No forwarding or preliminary summary; allow genuinely required dependent assignments                            | Explicit prompt rule is present, but live named routing still failed once                                                                   |
| Renewed human request                        | Earlier exchanges are background; an existing answer does not satisfy a renewed request to involve a specialist | Current-exchange boundary and scoped deduplication are tested; the long-lived browser room still ignored the requested writer participation |
| Evidence of superseded constraints           | One minimal correction; no routine supervision                                                                  | Three fixed live correction samples passed in the final assistant evaluation                                                                |
| Valid or incomplete specialist work          | Silence during ordinary work; preserve incomplete status at closing                                             | Live evaluation passed                                                                                                                      |
| Closing assignment                           | Only `say`, fixed recipient and source range, no ordinary guidance or workspace tools                           | Provider-boundary tests verify assembled tools and prompts                                                                                  |
| Application override                         | Additional instructions survive ordinary and closing activation and override behavioral defaults                | Assembled-context tests and live silence override passed                                                                                    |
| Human preferences                            | Private presentation preferences reach closing only                                                             | Assembled-context tests verify separation; ordinary working preferences must be shared explicitly                                           |
| Source-only verification                     | Do not infer shipped, deployed, or runtime-verified behavior                                                    | Live closing-summary evaluation passed                                                                                                      |

## Changes made during acceptance

- Mark the beginning of the active exchange in ordinary context and identify its
  opening message. Limit answer deduplication to the current exchange.
- Treat earlier summaries as reports that yield to corrections and conflicting
  concrete evidence.
- Explicitly prohibit forwarding specialist results during ordinary activation,
  including results arriving after a directed assignment.
- Clarify that default silence does not excuse outstanding requested actions,
  including renewed specialist participation despite an existing artifact.
- Add provider-boundary regression tests for ordinary and closing contexts, and
  fixed repeated live samples for named routing and exceptional steering.
- Strengthen Relay acceptance with workspace snapshots, a single revision
  activation, and repeated requests after unseating with an existing draft.

The broader implementation also fixes directory-backed root traversal in the
workspace shell, preserves no-edit constraints in Relay roles and handoffs,
and excludes shell `/dev` artifacts from the project's file browser.

## Validation

- `pnpm check`: passed formatting, build, types, lint, and deterministic tests.
  The assistant package has six deterministic tests, including two assembled
  activation-context scenarios.
- `node scripts/cli-team-smoke.mjs`: passed packed consumer exports, types,
  assistant shorthand startup, and resume checks.
- Assistant provider evaluation with `--retry 0`: **10/11 passed**. One of three
  named-routing samples sent the human an ordinary copy of the specialist's
  answer. The three correction samples, broadcast/default routing, valid-work
  silence, application override, and source-only summary cases passed.
- Relay provider evaluation after rebuilding, with `--retry 0`: **5/6 passed**.
  Design produced no expected planner contribution. Delivery, launch, no-edit
  triage, one directed writer revision, and renewed participation with an
  existing draft passed. The fresh-room renewal pass does not resolve the
  persisted browser-history failure.
- Browser: the renewed R-19 request in the resumed triage room still left writer
  unseated and presented the old draft as satisfying the current request. All
  seven project artifacts matched their pre-test SHA-256 hashes; the no-edit
  constraint held in this retest.

An earlier assistant run passed 11/11 and an earlier Relay run passed 6/6.
Subsequent no-retry runs exposed failures. Those earlier passes are evidence of
possible behavior, not reliable acceptance. A Relay run started before the last
package rebuild was interrupted and is excluded from the final result.

## Reliability follow-up for the evals package

1. Named routing can still produce an unnecessary human-directed ordinary
   answer after a specialist responds.
2. Explicit specialist participation can be skipped, particularly when an old
   answer or artifact appears sufficient in a long-lived room.
3. Closing summaries can overstate the absence of work: a closing view contains
   room messages, not every private tool result. It must distinguish “no result
   was recorded” from “no file was read.” The browser exposed this distinction.

The next step is to define an evals package with reproducible scenarios,
fixed repeated samples, persisted-history fixtures, prompt and tool traces,
and failure retention. Use that baseline to evaluate changes to activation
policy without hiding regressions in successful retries. Do not add a
blanket speech or tool prohibition that prevents application overrides,
necessary dependent assignments, or evidence-backed corrections. Do not mask
failures with retries or weaken assertions to accept missing specialist work.

See [the assistant contract](assistant.md) for the intended behavior and scope.
