# Formal verification

**The three core state machines are proven, and the code runs the proven
bodies.** The journal's fence, the activation lifecycle, and the exchange
lifecycle each decide by rules: pure TypeScript functions with a
contract. LemmaScript turns the contract into Dafny obligations, Dafny
proves them, and the gate fails when a proof breaks or a generated file is
stale. Two files hold every rule:

| File                                                                                          | Concern                                                                                            | Obligations                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| [`packages/journal/src/rules.verified.ts`](../packages/journal/src/rules.verified.ts)         | The fence, the key, the seq counter, the cursor                                                    | 12, and 23 in its proofs file |
| [`packages/ambion/src/room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts) | The lease fold, the admissions, the grant, the retry, the opening question, the verdict, the close | 74, and 36 in its proofs file |

**Everything else is ordinary TypeScript under the scripted and chaos
suites.** Routing, presence, the roster, addressing, membership changes,
the keyed retry, the reads, the pass's scheduling, the storage adapters,
and the validator's shape checks decide in their own files with no
contract. The line is deliberate: a proof pays for itself on a state
machine whose failure loses or duplicates work, and it costs a
redeclared type, a binding case, and a Dafny run on every edit. A concern
crosses the line when a defect in it would corrupt the record or the
lease history.

**A rule earns its place by what its contract says.** A rule stays when
its contract states a property the body does not restate: an invariant
of the fold, monotonicity, freshness, mutual exclusion, or an admission
that gates the record. A rule stays when a proof depends on it. A rule
whose contract only restates its body is a test, and it lives beside the
code as one.

**A change to a core state machine is a change to a rules file.** The
fold, the transition, and the pass project the state and run a rule. So
an edit to how the journal or the room decides lands in one of the two
files, `pnpm rule:check` proves that file in seconds, and the gate
refuses the edit until its proof, its binding case, and its type pin
agree.

This page states the mechanism: what a rule is, how its proof reaches the
running code, what the generated files are, how the gate runs them, and
what a contributor does to change one. [`planning/formal.md`](../planning/formal.md)
is the review that produced the rules and the work still open.

## 1. What a rule is

**A rule is a pure function with a `//@ contract` line and `//@ ensures`
clauses.** The contract line is one sentence a reader checks against the
design docs. Each `ensures` is a clause Dafny proves about the body. A
`//@ requires` states what the caller establishes before the call.

```ts
//@ contract Ended is final. A running lease is revoked at will, ends as expired only past its expiry, and as released or failed only before it.
export function mayEnd(
  known: LeasePhase | undefined,
  reason: LeaseEndReason,
  pastExpiry: boolean,
): boolean {
  //@ ensures known != undefined && known == 'ended' ==> !\result
  //@ ensures known != undefined && known == 'running' && reason == 'expired' ==> (\result <==> pastExpiry)
  if (known === undefined) return reason === 'revoked' || reason === 'abandoned';
  if (known === 'ended' || reason === 'abandoned') return false;
  if (reason === 'revoked') return true;
  return pastExpiry === (reason === 'expired');
}
```

**A rule reads values and answers a value.** It takes numbers, strings,
booleans, records, and arrays of them. It reads no clock, no journal, and
no regular expression. What a rule cannot read, the caller computes and
passes in. `Date.parse` on a stamp, the regular expression that decodes an
activation id, and `Number.isSafeInteger` on a wire value stay at the call
site.

**A rules file declares the types it reads.** LemmaScript lowers only the
types in its own file. A rules file therefore declares the string unions
and records its rules read, such as `LeaseEndReason` beside `EndReason`.
`rules.test.ts` in each package pins every copy to the public type with
`expectTypeOf`, so the two cannot drift without a compile error.

**A helper a contract names is a rule too.** `stoodDown` exists so that
`summaryVerdict` can say `!stoodDown(drafts)` in a clause. Such a helper is
not exported when only rules call it. Knip fails an export that nothing
imports, so a rule the runtime does not run cannot stay exported.

## 2. How a proof reaches the running code

**The proof is about the code the runtime runs.** A rule proves nothing
about the room until the room runs its body on the path the contract
describes. Three things hold that binding.

1. **The caller runs the rule.** `transition.ts` decides an end with
   `mayEnd`, `fold.ts` applies a lease change with `applyChange`, and
   `journal.ts` steps the fence with `fenceStep`. The caller projects the
   state into the rule's arguments and follows the rule's answer. A caller
   that computed the decision by hand would pass its own tests and fail
   the binding test.
2. **A binding test replaces each rule with a sentinel.**
   [`packages/ambion/test/binding.test.ts`](../packages/ambion/test/binding.test.ts)
   and [`packages/journal/test/binding.test.ts`](../packages/journal/test/binding.test.ts)
   wrap every exported rule, return a sentinel from one rule, and check
   that the decision follows the sentinel. One case per rule and call
   site, the host included. The file fails when an exported rule has no
   case, so a rule cannot gain an export without one.

**The call site holds the projection, and the rule holds the decision.**
`applyLease` in `lease.ts` reads one lease entry, finds the lease the fold
holds for its id, and asks `applyChange` for the lease after it.
`cancelLeases` in `fold.ts` asks `cancelHold` for each lease a
cancellation reaches. `openExchange` in `exchange.ts` maps the closes to
their `through` seqs, asks `lastOf` for the last, and asks
`openingQuestion` for the question after it. A comment at such a site
says "the rule decides" where a second check remains to narrow a
TypeScript type.

## 3. The generated files

**Each rules file has a `.dfy.gen` and a `.dfy` beside it, and they are
the same file.** `lsc gen` writes the `.dfy.gen`: one Dafny datatype per
record or named union, one function per rule, and one `_ensures` lemma per
rule that states the contract. The `.dfy` is the file Dafny verifies, and
nothing hand-written goes in it, so `lsc regen` after an edit is a copy
and never a merge.

**A hand-written proof goes in a `.proofs.dfy` beside the rules.** The
generator cannot write an inductive proof. The journal's proofs file
proves the fence lemmas by induction over a read: a superseded journal
stays superseded, the caller hears `lost` at most once, the cursor never
moves back. The room's proofs file proves these lemmas:

- `AttemptIdsAreFresh`: no two attempts in one lease history share an id.
- `LeaseHistoryKeeps` and `FirstChangeFixesStart`: they fold every
  history of changes and cancellation markers the rules admit. The first
  change fixes `since` and `claimedAt`. The read position never moves
  back. An ended lease stays as it ended.
- `OneOpenExchange`: the open exchange is the earliest question after the
  last close. Every other question that could open one comes at or after
  it.
- `CloseExtendsTheRecord`: a close that starts at that question and ends
  at the record's last seq keeps the closes ordered. So no two exchanges
  overlap, and every question after the last close lands inside the
  closed range. The close the room admits and the close a cancellation
  carries both have that shape; `AdmittedCloseExtendsTheRecord` derives
  the first from `admitsClose`.
- `StillExpired` and `EndingStands`: an expiry stays expired as the clock
  moves forward.

A proofs file starts with `include` of the generated file and calls the
generated `_ensures` lemmas. `check-extra.sh` at the root verifies every
proofs file, at a desk and in CI.

**A contract states what Dafny proves on its own.** A clause that needs
induction is a lemma in the proofs file, and the rule's `//@ contract`
line names that lemma.

## 4. The gate

**`pnpm check` regenerates, and `pnpm check:lemmascript` proves.**

| Command                  | What it runs                                                                 | Needs Dafny |
| ------------------------ | ---------------------------------------------------------------------------- | ----------- |
| `pnpm check`             | `lsc gen-check`: regenerate every `.dfy.gen` and fail on a stale one         | No          |
| `pnpm rule:check <file>` | Regenerate one rules file, prove it, and prove the proofs file beside it     | Yes         |
| `pnpm check:lemmascript` | `lsc check` on every listed file, then `check-extra.sh` on every proofs file | Yes         |

A stale generation fails at the desk and in CI. The proof itself runs in
the `lemmascript` job of `.github/workflows/ci.yml`, which calls the
LemmaScript reusable workflow at a pinned reference that names the
`lemmascript` version in `package.json`; that workflow runs
`check-extra.sh` after the listed files. The room file proves in about
fifteen seconds, and a rule edit re-proves only its own file.

**`LemmaScript-files.txt` lists what CI verifies.** One line per file:
`path [timeout] [dafny flags]`. A timeout above 60 turns the batch check
into a generation check with no proof, so every timeout stays at 60 or
below. A rule that calls `filter` needs `--standard-libraries` in the
flag column. `scripts/setup.sh` installs Dafny 4.11 for a desk run.

## 5. Change a rule

**Edit the body and the contract together, then check the file.**

1. Edit the rule in its rules file. Keep the function pure.
2. Run `pnpm rule:check <file>`. It regenerates the Dafny, proves the
   file, and proves the proofs file beside it. Read a failing clause as a
   claim the body does not make, and change one of the two.
3. Run `pnpm check`. It fails on a stale generation, an unused export, a
   redeclared type that drifted from its public type, an exported rule
   with no binding case, and a caller that stopped following the rule.

**Add a rule only inside the line, and where its caller may import it.**
A decision over the lease, an admission, a grant, the exchange, the
verdict, or the pass goes in the room's rules file. A rule the journal
decides by goes in the journal's rules file. A decision outside the three
machines stays ordinary TypeScript. The core is laid out in layers, and
an import points down only (`toolchain.md` §1). Then:

1. Write the projection at the call site and make the caller follow the
   rule's answer.
2. Add a binding case that replaces the rule with a sentinel. The binding
   file fails until every exported rule has one.
3. Pin every union or record the rule redeclares in `rules.test.ts`.
4. State each `//@ requires` at the call site as a guard, or as a comment
   that names the code that establishes it.

**A helper only a contract names is internal.** It carries a Biome
ignore that says which contract names it, as `markedCancelled` does. Two rules files cannot share a type: Dafny lowers
each file on its own, so a union both files read is declared in both and
pinned in both.

**Remove a rule by removing its caller first.** Knip fails an export with
no importer, so a rule that lost its caller fails the gate until it is
made internal or deleted.

## 6. What LemmaScript 0.6.1 lowers

**A rule stays inside these rows.** Each row was checked with `lsc gen`
and `dafny verify` on this repository.

| Construct                                                   | Result                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Records, discriminated unions on a literal field            | Verifies; each lowers to a Dafny datatype                                                                        |
| A named string-literal union                                | Verifies; an inline literal union in a parameter lowers to `string`, and a case split over it does not prove     |
| `T \| undefined`, narrowed in an `if` or under `==>`        | Verifies; a narrowing inside a return expression or a `\|\|` does not lower, and two optionals compared do not   |
| `Math.max`, `Math.min`, ternaries, object literals          | Verifies                                                                                                         |
| `xs.some(cb)`, `xs.includes(x)`, `xs.find(cb)`              | Verifies; `some` lowers to `exists`                                                                              |
| `forall(i, ...)` and `exists(i, ...)` in a contract         | Verifies; a quantifier with no function call inside it has no trigger, and Dafny refuses the warning             |
| An index loop with `//@ invariant` over `i`                 | Verifies when the body reads `xs[i] as T` under the loop bound                                                   |
| `for (const v of xs)`                                       | Lowers to a hidden index, so an index invariant cannot name it                                                   |
| A read `xs[i]` tested with `!== undefined`                  | Does not lower; cast the read with `as T` under the loop bound                                                   |
| An object literal as a default for `xs[i]`                  | Lowers to whichever record has those fields, so a literal that fits two records fails; cast the read with `as T` |
| A mutable `let x: T \| undefined` changed in a loop         | Does not type in Dafny; fold a sequence by recursion                                                             |
| Recursion over a sequence with `//@ decreases`              | Verifies                                                                                                         |
| `xs.filter(cb)`                                             | Lowers to `Std.Collections.Seq.Filter` and needs `--standard-libraries`; proves soundness only                   |
| `Map.has`, `Set.has`, `new Set(s).add(x)`                   | Verifies                                                                                                         |
| Two records with the same fields                            | Two Dafny datatypes; a rule over one does not take the other, so a shared predicate is written per record        |
| An import of a rule from another verified file              | Verifies when a body calls it; a call only inside a contract does not resolve                                    |
| `switch` over a named string union                          | Verifies                                                                                                         |
| The literal `'none'` as a return value                      | Lowers to `Option.None`; a scale returns a number                                                                |
| Regular expressions, `Date.parse`, `structuredClone`, async | Outside the envelope                                                                                             |

## 7. What the proofs say, and what they do not

**A proof says a body satisfies its contract for every input.** The
contract is the claim. Read the `//@ contract` line against the design
doc it carries:

- `docs/agent.md` for the activation rules;
- `docs/exchange.md` for the exchange and `docs/summary.md` for the
  verdict;
- `docs/durability.md` for the journal, the lease, and the retry.

**The rules cover the decisions, and the tests cover the rest.**

- The storage adapters and the SQL compare-and-append in `sqlite.ts` are
  outside the rules. The storage tests hold them.
- The record is ordered by seq, which the journal proves; `lastOf` and
  `openingQuestion` require it and no runtime check repeats it.
  `CloseExtendsTheRecord` takes the ordered closes as a premise, so it
  proves the step and the induction over a record is the reader's.
- The lease lemmas and the exchange lemmas hold over the histories the
  rules admit. The binding test proves `lease.ts`, `fold.ts`, and
  `exchange.ts` call those rules; the projection from an entry to a
  `Change` or a `Message` stays with the scripted suites.
- The clock never runs backwards. That is a host promise.
- A pass of the reconciliation converges. The chaos drain and the walk's
  `drained` check witness it; a measure over the fold is open work.
- The model's output, the transport, and the provider are outside every
  rule.

**A binding test proves the caller follows the rule and nothing more.** It
does not prove the projection at the call site is the right one. The
scripted suites and the chaos sweeps hold the projections, as they did
before the rules existed.
