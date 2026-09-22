# Simplify: consolidation scope for 0.2.0

This file lists the opportunities to simplify and consolidate the code and
the documents for the 0.2.0 release. [next.md](next.md) owns the 0.2.0
feature scope and the compatibility rule. [backlog.md](backlog.md) holds
everything after 0.2.0. This file owns the debt: the duplication, the split
concerns, and the scaffolding that no longer pays.

**Read this file with the yardstick from [next.md](next.md#the-model-to-preserve).**
Judge each item by the obligation it removes. Every item below names one
concrete duplication, export, or rule that it removes.

## The compatibility rule and the wave

**The compatibility rule governs the public shape since 0.1.0.** 0.1.0
shipped on 2026-09-21. [next.md](next.md) states the rule: a change to the
main entry or a journal body is additive, unless an item names a deliberate
break. The items divide into three shapes, and the shape sets the process
each one needs.

| Shape        | Meaning                                                                        | Process                                                                     |
| ------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **internal** | No public export changes; no journal body changes                              | An ordinary refactor. `pnpm check` guards it                                |
| **additive** | A new export from an existing entry, such as `@ambionframework/ambion/hosting` | The compatibility rule permits it. The export snapshot records the new name |
| **breaking** | Removes or renames a public export, or changes a stored body                   | A deliberate change. It needs a new golden journal or snapshot and a review |

**Three items are a deliberate break, so schedule them as one 0.2.0 wave**
with their goldens and snapshots: the pi-journal idempotency collapse
(T2.2), the `RoomObject.exchange` removal (T9.2), and the `speakOnce`
retirement (T10.2). The compatibility rule needs each break named as an
item. Every other item is internal or additive, so each lands on its own.

## How this analysis ran

The review ran on 2026-09-21 against `main` at `c543218`. Eleven readers
surveyed the subsystems: the three executor packages, the kernel room
layers, the execution layer, the verified rules, the core type surface, the
journal storages, the workspace package, the conformance suite, the CLI and
Cloudflare adapters, the document set, and a cross-package sweep. An
adversarial verifier judged each candidate against the design contracts, the
withdrawal decisions in [docs/formal.md](../docs/formal.md), the layer
rules, and the compatibility rule. A completeness critic then read the kept
set for gaps. The survey found 52 candidates. The verifier kept 37 and
rejected the rest as either intentional design or a change that adds caller
rules. This file merges the near-duplicate candidates into the items below.
PR #266 later shipped 0.1.0 and rewrote the 0.2.0 plan. It changed no
package source, so the file and line references below stand.

**The verifier rejected these as intentional, so they are not on the list.**
It rejected new proofs for the rules that [docs/formal.md](../docs/formal.md)
withdrew by decision. It rejected deleting the redeclared type copies in
`rules.verified.ts`, which Dafny needs and the layer rule pins. It rejected
merging the two conformance rooms behind one flag-heavy builder, which the
cognitive-complexity ceiling refuses. It rejected exporting a generic
`present()` utility from the `/hosting` entry, which states a protocol
contract and holds no room for a plain filter helper.

## The themes

**Nine themes group the work.** A theme is a duplication that spans several
files or packages. Land a theme as one change where the items share a home,
so the shared code arrives once.

| Theme                                                    | Items | Headline                                                                 |
| -------------------------------------------------------- | ----- | ------------------------------------------------------------------------ |
| T1. One executor-support surface in `hosting`            | 5     | The three executor packages write the same glue three times              |
| T2. One owner for the crash-safe append loop             | 4     | Three classes hand-write the same serial-queue and recovery loop         |
| T3. One owner for the executor contract in the documents | 1     | `pi.md`, `claude.md`, and `codex.md` restate `executors.md`              |
| T4. Read-only rules return to plain TypeScript           | 2     | A verified rule that only classifies a read view earns no proof          |
| T5. Each document fact has one home                      | 6     | Six facts appear on two or more pages                                    |
| T6. One home for the closing-summary text                | 2     | The summary duties appear in the executor and the assistant              |
| T7. Kernel decision layers                               | 4     | Test helpers and duplicate narrowings sit in the decision files          |
| T8. Workspace package                                    | 4     | The append-only logs repeat the best-effort write and the table renderer |
| T9. CLI and Cloudflare adapters                          | 3     | The generator and the Durable Object hold scattered per-template facts   |
| T10. Conformance and testing helpers                     | 2     | A second executor and a second poll loop shadow the testing entry        |

## T1. One executor-support surface in `hosting`

**The Pi, Claude, and Codex packages write the same glue three times.** They
already share the real machinery through `@ambionframework/ambion/hosting`:
`renderActivation`, `SAY`, `SEAT`, `UNSEAT`, `summaryToolDescription`,
`traceOpener`, `DEFAULT_TRACE`, and the `Executor` contract. The glue around
those pieces stays duplicated. Every item below adds one export to `hosting`
and deletes the copies. The layer rule permits this, because the three
packages already import `hosting` and point down only.

**Decide the final shape of `hosting` once.** These five items add exports to
one module. Design that module as a whole, then land the additions together,
so `hosting` grows once.

| Item                                    | What it removes                                                                                          | Effort | Shape    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------ | -------- |
| **T1.1 Connector composer**             | Five copies of the transport and trace-opener wiring, and four copies of the default trace-limit literal | small  | additive |
| **T1.2 Failure classifier**             | Three copies of the permanent status set and the permanent-or-transient decision                         | medium | additive |
| **T1.3 Option base and narrowing**      | Eighteen redeclared option fields, four copies of the drop-undefined filter, and three narrowing copies  | small  | additive |
| **T1.4 Seat-memory and resume helpers** | Three copies of the seat-memory test and two copies of the resume-id read                                | small  | additive |
| **T1.5 Room-tool bridge core**          | Twelve copies of the tool descriptions and three copies of the commit-result branch table                | large  | additive |

**T1.1. One connector composer and one trace-limit default.** The connect
body wires `traceJournals`, `transport ?? inProcessTransport()`, and a
`traceOpener` call with the same seven fields. The body repeats in
`claude/compose.ts:41`, `codex/compose.ts:41`, and `pi/compose.ts:44`. The
critic found two more copies of the seven-field block:
`ambion/src/room.ts:109` (`missingConnector`) and
`cloudflare/src/seat-object.ts:169`. The literal
`{ toolOutputBytes: 65_536, stepsPerPass: 1_000 }` appears in
`claude/compose.ts:24`, `codex/compose.ts:24`, `pi/services.ts:89`, and
`conformance-executor.ts:418`. Add `composeConnector({ host, buildExecutor,
traceLimits })` and `DEFAULT_TRACE_LIMITS` to `hosting`. Fold all five call
sites onto the composer. The composer takes `buildExecutor` as a closure, so
Pi threads its `services` and passes `traceLimits: services.trace`, and
Claude and Codex pass `DEFAULT_TRACE_LIMITS`. This keeps the rule that Pi
applies the host trace limits and the others apply the default
([executors.md](../docs/executors.md)).

**T1.2. One permanent-or-transient failure classifier.** The set
`PERMANENT_STATUS = new Set([400, 401, 402, 403, 404, 405, 422])` is
byte-identical in `pi/executor.ts:469`, `claude/services.ts:9`, and
`codex/services.ts:11`. The permanent-text regex shares one alternation core
across all three. Export `PERMANENT_STATUS` and a
`classifyCause({ text, status, permanent })` helper beside `FailureCause`
(`types.ts:26`). Each package keeps its own status source and its own extra
regex terms, because [docs/durability.md](../docs/durability.md) states that
Pi reads a status from a diagnostic and never from free error text, while
Codex reads a status from the text. Keep each package's own classification
test, so no classification behavior moves.

**T1.3. One executor-option base, filter, and narrowing.** `ExecutorOptions`
(`define.ts:56`) already declares and exports the six neutral fields, and
`describeExecutor` already consumes them. `PiOptions`, `ClaudeOptions`, and
`CodexOptions` redeclare all six with the same doc comments, which is
eighteen redeclarations. `present<T>()` is identical in `claude/options.ts:84`
and `codex/options.ts:44`. The narrowing that throws "cannot run an executor
of kind" repeats in `claude/options.ts:22`, `codex/options.ts:24`, and
`pi/executor.ts:446`. Make the three Options interfaces extend an
`AgentExecutorBaseOptions`. Structural typing keeps each exported type the
same shape, so this is additive. Add `executorOfKind(executor, kind)` for the
Claude and Codex narrowing. Pi keeps `modelOf`, because it returns the model
string and applies no kind check today. Keep `present()` as a private shared
module. It states no protocol contract, so it earns no `hosting` export.

**T1.4. Shared seat-memory and resume helpers.** The seat-memory test
`'memory' in definition.executor && definition.executor.memory === 'seat'`
is identical in `claude/executor.ts:63` and `codex/executor.ts:66`, and
inline in `pi/executor.ts:101`. The resume-id read is near-identical in
`claude/executor.ts:452` and `codex/executor.ts:72`, and differs only by the
harness name. `HarnessSession` is already a `hosting` type. Add
`resumesForSeat(executor)` and `sessionToResume(view, harness)` to `hosting`,
and point all three packages at them.

**T1.5. One room-tool bridge core.** Land this item on its own, because it is
the largest and it borders the intentional per-harness wrapper. Two parts are
safe to share. First, the three tool descriptions ("Speak on the record…",
"Seat one agent…", "Remove one seated agent…") are byte-identical in three
packages and belong beside `SAY`, `SEAT`, and `UNSEAT`. Second, the
commit-result branch table (`committed` and `unchanged` deliver, `refused`
carries the refusal, `unknown` aborts, `stale` ends the turn) repeats in
`pi/tools.ts:88`, `claude/tools.ts:78`, and `codex/tools.ts:73`. Add a pure
`classifyCommit(response)` that returns a tagged outcome. Keep three things
per harness, because they differ by design: the `saidBy` intent shaping
(Codex folds changed-path refs to `file:` URIs), the missed-say read-advance
(Claude uses an async echo, Codex is synchronous, Pi throws), and the
turn-end signal (Pi throws or terminates, Claude and Codex return an error
result). Each package renders the shared outcome into its own SDK shape.

## T2. One owner for the crash-safe append loop

**Three classes hand-write the same serial-queue and recovery loop.** The
`Journal` class (`journal/src/journal.ts`), `JournalAuditSession`
(`pi-journal/src/index.ts`), and `MetadataJournal`
(`cloudflare/src/storage.ts`) each carry a serial promise queue, a
cursor-scan replay clamped by `scanned`, and a conditional append with
recovery by id after an in-doubt write.
[docs/durability.md](../docs/durability.md) names the journal as the single
owner of ordered, conditional, crash-safe append. Two more storage classes
trust the same correctness by hand.

| Item                                 | What it removes                                                                          | Effort | Shape    |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | ------ | -------- |
| **T2.1 One append primitive**        | Two hand-written copies of the queue, the cursor replay, and the in-doubt recovery       | large  | internal |
| **T2.2 One idempotency key**         | pi-journal's second recovery key, its `mutations` map, and its content re-scan           | medium | breaking |
| **T2.3 Prune pi-journal projection** | One dead index (`entryMutations`) and one duplicate index (`usedIds`)                    | small  | internal |
| **T2.4 Fold `positionRead`**         | A second, unproven copy of the read-position clamp that the verified `scanned` rule owns | small  | internal |

**T2.1. Extract one append primitive in `packages/journal`.** Extract an
internal helper that owns the serial queue, the cursor-scan replay, and the
try-append then re-read then recover-by-id loop. The helper takes an
`apply(state, stored)` callback and a `recover(state, attempt)` callback.
Rebuild `JournalAuditSession` and `MetadataJournal` on it, and keep every
stored record byte-identical, so nothing on disk changes. Keep the projection
and the idempotency logic at the call site, because the `Journal` class reads
no body meaning and the primitive keeps that boundary. Do not route the two
consumers through the `Journal` class, because that would wrap their records
in the run fence and the envelope they do not use, and would rewrite the
pi-journal on-disk format. Gate this change on the chaos suite and the restart
suite, because it is crash-recovery code.

**T2.2. Collapse pi-journal to one idempotency key.** Every stored mutation
carries `id: crypto.randomUUID()` (`pi-journal/src/index.ts:225`).
`recoverEntry` first reads `state.mutations.get(mutationId)` and then falls
back to `entriesById.get(source.id)`. The caller-stable `source.id` already
answers the same in-doubt-write question, and `hasMetadata` already
recognizes the metadata write by its stable `metadata.id`. Drop the random
`id` field, the `mutations` map, and the content re-scan in
`metadataRecovered`. [docs/durability.md](../docs/durability.md) §2 promises
at-most-once under retry from one stable key. Keep `sameEntry` (`171`): it
distinguishes an in-doubt retry from a caller who supplies a colliding id with
different content, and it raises "Session id already exists" for the second
case. This drops a stored field, so it changes the on-disk mutation record. It
needs a "reads as before" story like the other stored-field changes. Decide
the same key question for `MetadataJournal`, which uses the same random-UUID
recovery, so the primitive from T2.1 serves one idempotency contract.

**T2.3. Prune the pi-journal projection state.** `entryMutations`
(`pi-journal/src/index.ts:59`) has a `.set` and no reader anywhere. `usedIds`
(`58`) holds the same key set as `entriesById`, and `requireUnused` reads
`usedIds.has(id)`, which `entriesById.has(id)` answers. Delete both. The state
is a module-private projection, so no stored format and no export moves. This
item can land as ordinary cleanup at any time.

**T2.4. Fold `positionRead` into the verified `scanned` rule.**
`positionRead(after, head)` (`journal/src/storage.ts:52`) is a second,
unproven statement of the monotone clamp that the verified `scanned` rule
(`rules.verified.ts:74`) owns. The Cloudflare metadata store already uses
`scanned` for the same purpose (`storage.ts:79`). Replace the two callers in
`memory.ts:16` and `sqlite.ts:41` with the guarded `scanned`, and keep the
empty-read branch that returns `after`, because `scanned` needs a
non-negative position. Delete `positionRead`.

## T3. One owner for the executor contract in the documents

**`pi.md`, `claude.md`, and `codex.md` restate `executors.md`.** The three
pages carry a near-identical heading spine and state the driver-executor
contract three times. [docs/executors.md](../docs/executors.md) is defined to
own that contract. The code consolidation in T1 makes this document overlap
larger while it stays.

| Item                                | What it removes                                                                      | Effort | Shape    |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ------ | -------- |
| **T3.1 One executor contract page** | Three restatements of the activation flow, the step vocabulary, and the failure rule | medium | internal |

**T3.1.** Make `executors.md` the single owner of the shared contract: the
activation flow, the step vocabulary, the failure classification, the
room-tool bridge, and the seat memory. Trim `pi.md`, `claude.md`, and
`codex.md` to their per-adapter facts, and link the shared contract. Pair this
with T1, so the code and the document collapse the same restatement together.

## T4. Read-only rules return to plain TypeScript

**A verified rule that only classifies a read view earns no proof.**
[docs/formal.md](../docs/formal.md) draws the line: a proof pays for itself on
a rule whose fault loses or duplicates the record. [planning/formal.md](formal.md)
records a pass that withdrew every rule whose contract restated its body. One
rule sits below that line today, and the rest of the exported rules need the
same test.

| Item                                | What it removes                                                                    | Effort | Shape    |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ------ | -------- |
| **T4.1 Withdraw `exchangeOutcome`** | One verified rule, its eight-clause lemma, one datatype, one binding case, one pin | small  | internal |
| **T4.2 Withdrawal sweep**           | Every remaining rule that only classifies a read view                              | medium | internal |

**T4.1. Return `exchangeOutcome` to plain TypeScript.** `exchangeOutcome`
(`rules.verified.ts:403`) has one source caller, `exchangeOutcomeOf`
(`exchange.ts:188`), which fills the read-view `outcome` field for
`closedExchangeView`. It gates no journal write. No hand-written lemma
references it. Its seven `ensures` clauses restate its own priority cascade.
Move the cascade into `exchange.ts` as a plain function that returns
`ExchangeOutcome['kind']`, which stays a public type. Delete the rule, its
datatype, its generated lemma, its binding case (`binding.test.ts:177`), and
its pin (`rules.test.ts:54`). Behavior stays the same.

**T4.2. Run a withdrawal sweep over the remaining exported rules.** Classify
each exported rule in `rules.verified.ts` by one test: a fault in it either
loses or duplicates the record, or it only misclassifies a read view. Keep the
rules that gate a journal write, such as the say lock, the close admission,
and the lease step. Withdraw the rules that only shape a read view. Deliver a
justified keep-or-withdraw list, so `exchangeOutcome` becomes one entry in a
reasoned set. Most rules stay, because they decide a commit.

## T5. Each document fact has one home

**Six facts appear on two or more pages.** The positioning rule in
[CLAUDE.md](../CLAUDE.md) states that the README holds the positioning and
every other page states nothing twice. Each item below gives one fact a single
owner and links to it from the other pages.

| Item                                | The duplicated fact                                  | Owner                | Effort | Shape    |
| ----------------------------------- | ---------------------------------------------------- | -------------------- | ------ | -------- |
| **T5.1 Version-2 composition rule** | The legacy-refusal and resume rule, in three pages   | `room.md`            | small  | internal |
| **T5.2 The two spans**              | The activation and exchange span table, in two pages | `room.md`            | small  | internal |
| **T5.3 What is new**                | The ownership of "what is new", split over two pages | `technical-facts.md` | medium | internal |
| **T5.4 Assistant shorthand**        | The seats normalization, restated in `roster.md`     | `assistant.md`       | small  | internal |
| **T5.5 Tool-call provenance**       | The provenance subset, on three pages                | `resources.md`       | small  | internal |
| **T5.6 The patterns index**         | Owned mechanism, restated in a pure index            | the owning pages     | small  | internal |

**T5.1.** The legacy-refusal rule repeats in `room.md:156`, `summary.md:144`,
and `roster.md:100`. It is a general room fact. Keep `room.md` §History and
limits as the home, and replace the other two with a link.

**T5.2.** The two-spans table is identical in `room.md:56` and
`exchange.md:18`. Keep the table in `room.md`. Keep the surrounding framing in
`exchange.md` and link the table. Keep the `turn` and `round` distinction in
`room.md` §Controlled vocabulary, which the Glossary omits.

**T5.3.** `technical-facts.md:3` claims to hold "what is new", which is the
README's scope, and `next.md:42` points readers at the README for the ten
novelties that live in `technical-facts.md:60`. Reword the ownership sentences
so the README holds the headline and `technical-facts.md` holds the
enumeration. Fix the `next.md:42` pointer. Keep the ten bullets where they are.

**T5.4.** Four pages mention the assistant shorthand. Three already link
`assistant.md`. `roster.md:36` restates the full seats normalization, which
`assistant.md:100` owns. Trim `roster.md` to one sentence and a link. Leave
the scoped mentions in `agent.md` and `summary.md`.

**T5.5.** The provenance statement "room, activation, exchange; all three
absent outside a room; provenance grants no authority" repeats in `agent.md:78`,
`resources.md:116`, and `workspace.md:89`. Make `resources.md` the owner,
because it holds the provenance columns. Keep the `ctx.agent` and `ctx.signal`
fields in `workspace.md`, because its tool examples call them.

**T5.6.** `patterns.md:5` promises no mechanism, then restates the owner rules
and cites `multi-summary.test.ts` and `exchange-outcome.test.ts`, which the
owning pages do not cite. Keep the primitives table and the human-pattern
framing. Cut the restated derivations. Move the two test citations to
`summary.md` and `exchange.md`.

## T6. One home for the closing-summary text

**The summary duties appear in the executor and the assistant.** The seat
executor holds the generic summary guidance. The default assistant holds a
richer, Pi-tuned copy. [CLAUDE.md](../CLAUDE.md) states that summary guidance
belongs with the seat executor.

| Item                                        | What it removes                                                       | Effort | Shape    |
| ------------------------------------------- | --------------------------------------------------------------------- | ------ | -------- |
| **T6.1 Fold `summary.ts` into `render.ts`** | A whole-file split whose content is participant text `render.ts` owns | small  | internal |
| **T6.2 Audit the assistant duties**         | The closing-summary duties, stated in the executor and the assistant  | small  | internal |

**T6.1.** `execution/summary.ts` holds `SUMMARY_DUTIES` and
`summaryToolDescription`. `render.ts` owns every sibling closing-seat string,
imports `SUMMARY_DUTIES`, and is defined as "everything a participant reads".
Move both values into `render.ts`, delete the file, and re-export
`summaryToolDescription` from `render.ts` through `hosting.ts:38`. The export
name stays the same, so no public shape moves.

**T6.2.** `SUMMARY_DUTIES` (`execution/summary.ts:3`) and the assistant
closing paragraph (`assistant/src/index.ts:39`) both state the closing-summary
duties: answer the opening question, and keep decisions, evidence, artifact
paths, constraints, dates, quantities, owners, and unfinished work. Audit
whether the shared duties are one contract. Where they match, have the
assistant reference the shared duties. The assistant copy is richer and adds
verification-limit rules, so keep the parts that only the assistant needs.

## T7. Kernel decision layers

**Test helpers and duplicate narrowings sit in the decision files.** The
`room/` layer decides commands into events. Some files carry a test oracle or
a second narrowing that a lower file already owns.

| Item                                | What it removes                                                       | Effort | Shape    |
| ----------------------------------- | --------------------------------------------------------------------- | ------ | -------- |
| **T7.1 Relocate `evolve`**          | A test-only fold helper, and three fold imports, from `transition.ts` | small  | internal |
| **T7.2 One retry matcher**          | Two copies of the said-message identity comparison for keyed retry    | small  | internal |
| **T7.3 Fold `summaryOutcome`**      | A second copy of the summary-status narrowing over the four outcomes  | small  | internal |
| **T7.4 One recorded envelope base** | Fifteen redeclared stamp fields across the three message kinds        | small  | internal |

**T7.1.** `evolve` (`transition.ts:101`) has no production caller. Every
caller is a test. It is the only reason `transition.ts` imports `baseOf`,
`applyEvent`, and `project` from `fold.ts`. Move `evolve` to test support, drop
the three imports, and correct the comment that claims the live path uses it.

**T7.2.** `contributionMatches` (`control.ts:53`) and `deliveryMatches`
(`people.ts:66`) both compare a committed said message by its `to`, `text`, and
`refs`. `core.ts` owns the sibling helpers `sameRefs` and `messageKeyConflict`.
Add `saidContentMatches` to `core.ts` and call it from both. Keep the
activation-id guard and the summary branch at each call site. A future
additive said field then updates one comparison.

**T7.3.** `summaryCompletion` (`exchange.ts:59`) narrows `summaryVerdict` into
`SummaryOutcome`. The private `summaryOutcome` (`exchange.ts:362`) calls it and
re-narrows the same four statuses to copy the published summary for the read
view. `waits.ts` already consumes `summaryCompletion` and copies at its own
edge. Delete `summaryOutcome`. Call `summaryCompletion` from
`closedExchangeView` and copy the one published summary at that edge.

**T7.4.** `SpokenMessage`, `PresenceMessage`, and `SummaryMessage`
(`types.ts:155`, `193`, `236`) each redeclare `seq`, `key`, `activationId`,
`wakes`, and `at`, which is fifteen redeclarations. The idempotency-token doc
for `key` lives only on `SpokenMessage`. Add an internal `Recorded` base with
the centralized `key` doc, and make the three interfaces extend it. Keep the
per-kind fields local, because `from` is required on two kinds and optional on
presence. Interfaces are structural and the `Message` union stays the same, so
this is internal. Verify the projection-equivalence test and the export
snapshot after the edit.

## T8. Workspace package

**The append-only logs repeat the best-effort write and the table renderer.**
`log.ts` is documented as the core every append-only log shares. Two logs
carry their own best-effort write, and two SQL surfaces carry their own table.

| Item                                 | What it removes                                                           | Effort | Shape    |
| ------------------------------------ | ------------------------------------------------------------------------- | ------ | -------- |
| **T8.1 One best-effort record path** | Three copies of `reportError`, two copies of the append-rotate-catch body | medium | internal |
| **T8.2 One rotated-file list**       | Two copies of the "which files belong to this log" rule                   | medium | internal |
| **T8.3 One Markdown table renderer** | A second copy of the table renderer and the cell-escaping rule            | small  | internal |
| **T8.4 One tool-call envelope**      | Two copies of the provenance stamp prefix in `tools.ts`                   | small  | internal |

**T8.1.** `reportError` is byte-identical in `audit.ts:129`, `changes.ts:117`,
and `mirror.ts:134`. `DEFAULT_MAX_BYTES` repeats in `audit.ts:24` and
`changes.ts:22`. The append-then-rotate-then-catch body appears twice. Add a
best-effort record wrapper and one `reportError` to `log.ts`. The wrapper takes
the write closure, so `audit.ts` passes its `recordEntry` with its
`RecordTooLarge` fallback and `changes.ts` passes `appendLine` and
`rotateIfDue`.

**T8.2.** The "which files belong to this log" rule is written twice as the
inverse of `rotatedName` (`log.ts:45`): `changes.ts:88` and `mirror.ts:98`. Add
one file-list helper to `log.ts` beside `rotatedName`. Keep each caller's own
per-line read, because `changes.ts` parses every line and `mirror.ts` reads the
last line for a maximum.

**T8.3.** `sql.ts:237` and `sql-resource.ts:283` build the same Markdown table
and carry a near-identical cell escaper. Extract a pure, import-free
`markdownTable` module, and let both files import it and pass their own footer
hint. The module imports nothing, because `sql-resource.ts` is the `/sql` entry
that needs no model library. Keep the two `PREVIEW_ROWS` constants separate,
because they are per-surface defaults. Keep the `Uint8Array` branch in the
shared cell.

**T8.4.** Within `tools.ts`, `auditEntry` (`43`) and `recordChange`'s entry
(`80`) build the same prefix: `time`, `room`, `agent`, `tool`, and the
`activation` and `exchange` spreads. Add a private `callEnvelope(tool, ctx)`.
Each caller invokes it separately, so the timestamp stays per call, and each
entry keeps its own fields.

## T9. CLI and Cloudflare adapters

**The generator and the Durable Object hold scattered per-template facts.**
One item is a clean internal consolidation. Two items are decisions.

| Item                                  | What it removes                                           | Effort | Shape    |
| ------------------------------------- | --------------------------------------------------------- | ------ | -------- |
| **T9.1 One template descriptor**      | Four per-template maps kept in three files                | small  | internal |
| **T9.2 Remove `RoomObject.exchange`** | One public RPC method that filters over `read()`          | small  | breaking |
| **T9.3 Share the template team**      | Two copies of the sample team definition in the generator | small  | internal |

**T9.1.** Four `Record<Template, …>` maps live apart: `DEPENDENCIES`
(`project.ts:11`), `VARS_FILE` and `EXAMPLE_HINT` (`dev.ts:78`), and
`NEXT_STEPS` (`main.ts:29`). Define one `Record<Template, TemplateSpec>` in
`project.ts`, and let `dev.ts` and `main.ts` read their fields. This gives one
edit site for a new template.

**T9.2. Decide whether to remove `RoomObject.exchange`.** The method
(`room-object.ts:237`) calls `read({ messages: false })` and finds one
exchange by `from`. `read()` already returns every exchange, and the reacquire
path uses `waitForClose(from)` and `waitForSummary(from)` directly. Only the
Cloudflare tests call `exchange()`. It removes one public method whose behavior
is a filter over data the caller receives. One open question decides it: over
the Durable Object RPC boundary, `exchange(from)` returns one small reference,
and `read()` serializes the whole snapshot, so a by-`from` selector saves the
wire payload. Remove the method when a lean server-side selector holds no
value. Keep the method when the payload saving earns its place. Fix the
`cloudflare/README.md:27` reference when the decision lands.

**T9.3.** `node/src/room.ts` and `cloudflare/src/room.ts` differ by one line,
the `agents` name list that Cloudflare resolves through `configure()`. The
generated starters are code the user then owns, so the two trees may diverge,
and the CLI smoke test catches any drift that breaks the build. This item holds
low value. If it lands, factor only the host-agnostic team definitions into a
shared fragment, and keep each composition idiomatic for its host.

## T10. Conformance and testing helpers

**A second executor and a second poll loop shadow the testing entry.** The
`/conformance` and `/testing` entries are public, so two items are decisions.

| Item                                   | What it removes                                                        | Effort | Shape    |
| -------------------------------------- | ---------------------------------------------------------------------- | ------ | -------- |
| **T10.1 Share scripted-room fixtures** | Two copies of the seeded question, the participants block, and `stale` | medium | internal |
| **T10.2 Retire `speakOnce`**           | A second executor implementation, and one `/conformance` export        | small  | breaking |
| **T10.3 One poll loop**                | A second copy of the deadline-and-pause loop in the suite              | small  | internal |

**T10.1.** The two scripted rooms in `conformance.ts` and
`conformance-executor-room.ts` share a verbatim core: the "When is the pour?"
question, the participants block, and the `stale` constant. Lift only that
shared data into `conformance-support.ts`. Keep the two builders separate,
because one holds the view and one holds the commit, and a merged builder would
breach the cognitive-complexity ceiling.

**T10.2. Decide whether to retire `speakOnce`.** `speakOnce` (`conformance.ts:81`)
hand-writes the `Executor` contract, which `ScriptedSession`
(`testing/scripted.ts:137`) already implements. The `TransportHarness` contract
names `speakOnce()` as its minimal reference. A removal makes external
transport authors build an `AgentDefinition` and import `scriptedExecutor`, so
callers need more rules. Keep `speakOnce` as the minimal reference, or replace
it with an equally short zero-argument helper from `/conformance`. This removes
a public export, so schedule it in the 0.2.0 wave.

**T10.3.** `traceWhenEnded` (`conformance-executor.ts:445`) duplicates the
deadline-and-pause structure of `until` (`conformance-support.ts:18`). The two
differ: `until` polls a synchronous predicate, and `traceWhenEnded` awaits a
fresh trace and returns it. Widen `until` to accept an async predicate, or add
a sibling helper, and keep the timeout message. This item holds low value, so
bundle it with the other conformance cleanup.

## Sequencing

**Land the internal items first, then the 0.2.0 breaking wave.** The internal
and additive items need no golden or snapshot change, so each lands on its own
behind `pnpm check`. The three deliberate breaks need new goldens or snapshots
and a review, so they land together as one wave.

**Group the shared-home themes.** T1 adds five exports to `hosting`, so design
the module once and land the additions together. T2.1 extracts one primitive
that T2.2 then keys, so land T2.1 before T2.2. T3 pairs with T1, so the code
and the document collapse the same restatement together.

| Order | Items                                                     | Reason                                                        |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------- |
| 1     | T2.3, T2.4, T4.1, T6.1, T7.1, T7.2, T7.3, T8.1–T8.4, T9.1 | Internal cleanups. Each is small and stands alone             |
| 2     | T1.1–T1.5 with T3.1                                       | The `hosting` surface and the executor documents, as one pass |
| 3     | T2.1, T4.2, T5.1–T5.6, T6.2, T7.4, T10.1, T10.3           | Larger internal work and the document dedup                   |
| 4     | T2.2, T9.2, T10.2                                         | The breaking wave, with goldens, snapshots, and a review      |

## Evidence

**Each item lands with its evidence.** The gate is `pnpm check`. Some items
need more.

- **T2.1 and T2.2** need the chaos suite and the restart suite, because they
  change crash-recovery code.
- **T4.1 and T4.2** need `pnpm rule:check` on the edited file and
  `pnpm check:lemmascript`, and they update the tables in
  [docs/formal.md](../docs/formal.md) and [planning/formal.md](formal.md).
- **T1.3, T7.4, and T10.2** need the export snapshot (`test/package.test.ts`)
  to record the additive export or the deliberate removal.
- **T2.2** needs a new golden journal and a "reads as before" note, because it
  changes a stored body.
- **The document items (T3, T5, T6.2)** need a read for the positioning rule:
  the README holds the positioning, and every other page states nothing twice.

## What this file does not scope

**This file scopes debt.** [next.md](next.md) owns the 0.2.0 feature themes:
wake sources, delegation by reference, the bounded projection, and the
release work. [backlog.md](backlog.md) holds everything after 0.2.0.
[formal.md](formal.md) owns the verified rules still to write. A new
capability belongs in one of those files.
