# Formal evidence

**Each file here is a rule group [the plan](../../formal.md) proposes, as
LemmaScript source that Dafny verifies.** A group lands in a package's
`rules.verified.ts` when its slice lands; until then the file here is
the proof that the rules can be written and proven inside the envelope.
`LemmaScript-files.txt` lists every file here, so CI verifies them with
the landed rules, and a contract that stops proving fails the build.

A file copies the landed rules its contracts name, so it verifies on its
own. The copy is the reference for the slice; the landed file wins where
the two differ. A `.dfy` beside a file carries hand-written lemmas below
the generated ones, and `lsc check` holds the pair to additions only.

| File                  | Slice | Obligations | Verified with                 |
| --------------------- | ----- | ----------- | ----------------------------- |
| `reconcile.rules.ts`  | 2c    | 35          | LemmaScript 0.6.1, Dafny 4.11 |
| `transition.rules.ts` | 2a    | 37          | LemmaScript 0.6.1, Dafny 4.11 |
| `exchange.rules.ts`   | 2f    | 52          | LemmaScript 0.6.1, Dafny 4.11 |
| `routing.rules.ts`    | 2d    | 41          | LemmaScript 0.6.1, Dafny 4.11 |

Verify one file at a desk:

```sh
npx lsc check --backend=dafny planning/evidence/formal/reconcile.rules.ts
```
