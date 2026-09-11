# @ambionframework/record

An append-only record over a [Pi](https://github.com/earendil-works) session:
one serial queue, fenced by run, checkpointed, and honest about a write it is
in doubt about.

The _record_ is what a journal holds, and `Journal` is the structure that
holds it. It knows no room, no seat and no agent.

## Install

```sh
pnpm add @ambionframework/record
```

## The envelope

Every entry shares one envelope. `kind` is what the writer called it, and
`body` is what the writer wrote — the journal never reads a body. Exactly one
position: `seq` for an entry that took a place on the record, `after` for one
that sits beside them.

```ts
interface Entry<TBody> {
  kind: string;
  body: TBody;
  seq?: number;
  key?: string;
  after?: number;
  run?: string;
}
```

The journal holds every entry to that envelope, and it is strict: a kind this
reader does not know, a body the caller turns down, or a position of the wrong
sort is no entry at all.

## The vocabulary

A caller names its own kinds, and the journal reads none of them.

```ts
import { Journal, type Vocabulary } from '@ambionframework/record';

const words: Vocabulary<'note' | 'mark' | 'run' | 'checkpoint'> = {
  stored: (kind) => `app/${kind}`,
  kindOf: (customType) => customType.slice('app/'.length),
  positioned: 'note',
  run: 'run',
  checkpoint: 'checkpoint',
  accepts: (kind, body) => kind !== 'checkpoint' || isCheckpoint(body),
};

const journal = new Journal(open, words, (entry) => react(entry), runId, lost);
await journal.commit({ key, readThrough, draft: () => ({ text: 'hello' }) });
```

## What it promises

**A key lands once.** A repeated key returns the entry the first commit landed
and writes nothing, so a caller retries a commit whose outcome it never
learned.

**A commit the record moved past is refused.** `readThrough` names the seq the
author read. The queue refuses the commit and hands back what the author
missed.

**One run per name, fenced by its run entry.** Every entry a run writes carries
its run id. The fence is positional: a run entry moves it to that run, and an
entry of another run past it is void. A run that passes its own entry and then
one of another run has lost the name.

**A checkpoint replaces every entry before it**, and never a positioned one.

**A write in doubt is settled before anything lands on top of it.** The journal
reads the storage before every write, and again on the queue behind a write
that failed.

## The storage

`sqliteSessions` holds any number of Pi sessions in one SQLite database,
through two calls a host wraps its driver in. A process over `node:sqlite` and
a Cloudflare Durable Object over its own storage both reach it the same way.

## The contract

[`docs/durability.md`](https://github.com/ambionframework/ambion/blob/main/docs/durability.md)
states what the record promises under failure, and how the tiers prove it.
`rules.verified.ts` holds the rules the journal writes by, with contracts Dafny
checks.

## License

Apache-2.0
