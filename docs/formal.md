# Formal verification

**The rules the journal and the room decide by are proven, and the code
runs the proven bodies.** A rule is a pure TypeScript function with a
contract. LemmaScript turns the contract into Dafny obligations, Dafny
proves them, and the gate fails when a proof breaks or a generated file is
stale. Three files hold every rule:

| File                                                                                          | Concern                                                           | Obligations |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------- |
| [`packages/journal/src/rules.verified.ts`](../packages/journal/src/rules.verified.ts)         | The fence, the key, the seq counter, the cursor, the storage      | 41          |
| [`packages/ambion/src/room/rules.verified.ts`](../packages/ambion/src/room/rules.verified.ts) | Every decision the room makes over its fold                       | 200         |
| [`packages/ambion/src/rules.verified.ts`](../packages/ambion/src/rules.verified.ts)           | The ranges the validator admits and the domain the id codec takes | 3           |

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
   mock the rules module, return a sentinel from one rule, and check that
   the decision follows the sentinel. One case per rule and call site,
   the host included.
3. **A guard states each precondition where the rule is called.** A
   `//@ requires` is a promise the caller makes. `createRuntime` refuses a
   retry cap below one and a wake interval below one millisecond, because
   `givesUp` and `leaseExpiry` require them. `activationSpec` checks
   `wellFormed` on a decoded id before `activationGrant` reads it.

**The call site holds the projection, and the rule holds the decision.**
`foldPeople` maps each presence message to the six fields `foldPresence`
reads and returns what the rule answers. `messageDelivery` decodes each
lease id and asks `steers` per lease. A comment at such a site says "the
rule decides" where a second check remains to narrow a TypeScript type.

## 3. The generated files

**Each rules file has a `.dfy.gen` and a `.dfy` beside it.** `lsc gen`
writes the `.dfy.gen`: one Dafny datatype per record or named union, one
function per rule, and one `_ensures` lemma per rule that states the
contract. The `.dfy` is the file Dafny verifies. It is the generation plus
hand-written additions, and `lsc check` holds the pair to additions only.

**A hand-written lemma goes below the generated ones.** The generator
cannot write an inductive proof. The journal's `.dfy` proves the fence
lemmas by induction over a read: a superseded journal stays superseded,
the caller hears `lost` at most once, the cursor never moves back. The
room's `.dfy` proves `AttemptIdsAreFresh` over a lease history and the
roster induction behind `woken`. Such a lemma has no runtime caller, and
it lives only in Dafny.

**`lsc regen` merges a contract change into the `.dfy`.** It rewrites the
`.dfy.gen`, then merges the change into the `.dfy` three ways with the
previous `.dfy.gen` as the anchor. Run it after every edit and before any
`lsc gen`, because `lsc gen` overwrites the anchor. When the merge reports
a conflict, delete the `.dfy`, `.dfy.gen`, `.dfy.base`, and `.dfy.merged`
files, run `lsc gen`, and append the additions block again from version
control. The `.dfy.base` and `.dfy.merged` files are ignored by git.

## 4. The gate

**`pnpm check` regenerates, and `pnpm check:lemmascript` proves.**

| Command                                | What it runs                                                         | Needs Dafny |
| -------------------------------------- | -------------------------------------------------------------------- | ----------- |
| `pnpm check`                           | `lsc gen-check`: regenerate every `.dfy.gen` and fail on a stale one | No          |
| `pnpm check:lemmascript`               | `lsc check`: regenerate, then `dafny verify` on every `.dfy`         | Yes         |
| `npx lsc regen --backend=dafny <file>` | Regenerate one file and merge the change into its `.dfy`             | No          |

A stale generation fails at the desk and in CI. The proof itself runs in
the `lemmascript` job of `.github/workflows/ci.yml`, which calls the
LemmaScript reusable workflow at a pinned reference that names the
`lemmascript` version in `package.json`. The room's 200 obligations verify
in about thirty seconds, and the journal's 41 in three.

**`LemmaScript-files.txt` lists what CI verifies.** One line per file:
`path [timeout] [dafny flags]`. A timeout above 60 turns the batch check
into a generation check with no proof, so every timeout stays at 60 or
below. A rule that calls `filter` needs `--standard-libraries` in the
flag column. `scripts/setup.sh` installs Dafny 4.11 for a desk run.

## 5. Change a rule

**Edit the body and the contract together, then regenerate.**

1. Edit the rule in its rules file. Keep the function pure.
2. Run `npx lsc regen --backend=dafny <file>` and then
   `npx lsc check --backend=dafny <file>`. Read a failing clause as a
   claim the body does not make, and change one of the two.
3. Run `pnpm check`. It fails on a stale generation, an unused export, a
   redeclared type that drifted from its public type, and a caller that
   stopped following the rule.
4. When a `.dfy` addition names the rule, the regeneration carries it;
   verify that the addition still proves.

**Add a rule where its caller may import it.** The core is laid out in
layers, and an import points down only (`toolchain.md` §1). A decision
in `room/` goes in the room's rules file. A check in `journal/validate.ts`
or `activation-id.ts` goes in the vocabulary's rules file, because the
vocabulary imports nothing from `room/`. A rule the journal package
decides by goes in the journal's rules file. Then:

1. Write the projection at the call site and make the caller follow the
   rule's answer.
2. Add a binding case that replaces the rule with a sentinel.
3. Pin every union or record the rule redeclares in `rules.test.ts`.
4. State each `//@ requires` at the call site as a guard, or as a comment
   that names the code that establishes it.

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
- `docs/roster.md` for the roster and `docs/presence.md` for presence;
- `docs/durability.md` for the journal, the lease, and the retry.

**The rules cover the decisions, and the tests cover the rest.**

- The journal's storage adapters run the storage rules, and the SQL
  compare-and-append in `sqlite.ts` is outside the envelope. The storage
  tests hold it.
- The record is ordered by seq, which the journal proves; `lastOf`,
  `openingQuestion`, and `messagesSince` require it and no runtime check
  repeats it.
- The clock never runs backwards. That is a host promise.
- A pass of the reconciliation converges. The chaos drain and the walk's
  `drained` check witness it; a measure over the fold is open work.
- The model's output, the transport, and the provider are outside every
  rule.

**A binding test proves the caller follows the rule and nothing more.** It
does not prove the projection at the call site is the right one. The
scripted suites and the chaos sweeps hold the projections, as they did
before the rules existed.
