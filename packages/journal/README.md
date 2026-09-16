# @ambionframework/journal

`@ambionframework/journal` serializes an append-only journal. It owns the
queue, envelope, fencing, idempotency, and conditional appends. A caller
owns entry kinds and body validation.

The main package has no Pi dependency. It stores JSON data through a narrow
storage contract:

```ts
interface JournalStorage {
  read(after: number): Promise<{
    entries: readonly { position: number; entry: unknown }[];
    position: number;
  }>;
  append(
    entry: unknown,
    expectedPosition: number,
  ): Promise<{ position: number; entry: unknown } | undefined>;
}
```

`append` must atomically compare `expectedPosition` and append at the next
position. It returns `undefined` when the position moved. A read returns the
last scanned position. Adapters advance that position across foreign entries.

Journal storage positions order stored bytes. `seq` orders accepted journal
entries. The journal writes each stored value as a nested envelope:

```ts
{ kind, body, seq, key?, run? }
```

The nested body keeps JSON fields named `seq`, `key`, and `run` unchanged.
All journal payloads must be JSON data. Functions, resources, and cyclic
objects are not journal payloads.

```ts
import { Journal, memoryJournals, type Vocabulary } from '@ambionframework/journal';

const words: Vocabulary<'note' | 'run'> = {
  run: 'run',
  accepts: (kind, body): kind is 'note' | 'run' =>
    (kind === 'note' || kind === 'run') && typeof body === 'object' && body !== null,
};

const journals = memoryJournals();
const journal = new Journal(journals.open('weekly'), words);
await journal.append('note', {
  key: 'first',
  decide: () => ({ body: { text: 'Hello.' } }),
});
```

**One decision runs inside the queue, after recovery.** Return `{ body }` to
append, or `{ result }` to return a value without writing. The journal returns
`{ entry }` after storage confirms an append. Decisions must be synchronous.

**A key identifies one durable entry across all kinds.** A retry returns that
entry before the decision runs. Reusing its key for another kind fails. A
fence key also belongs to its original writer. A new writer must append its
own fence under the vocabulary's `run` kind.

**Migration:** `append` replaces `commit` and `write`. Remove the vocabulary's
`record` field and the third `Journal` type parameter. The caller derives
message views and freshness from entries. `record`, `since`, `lastCommitted`,
and generic `readThrough` are removed. The stored envelope is unchanged.

`sqliteJournals(sql)` provides SQLite storage with native compare-and-append.
`memoryJournals()` provides independent in-memory journals for one process.

The optional `@ambionframework/journal/pi` subpath opens Pi transcript
sessions over named native journal storage. `piSessions(journals)` gives Pi
each session a separate name in the same backend. The runtime uses this view
for seat audits. Workspace files use their separate workspace backend.

The 0.1.0 target extracts Pi transcript storage into
`@ambionframework/pi-journal`. That package change remains pending; use the
current subpath with this checkout. See the
[documentation index](https://github.com/ambionframework/ambion/blob/main/docs/README.md)
for current APIs and release targets.

See the [durability contract](https://github.com/ambionframework/ambion/blob/main/docs/durability.md)
for failure guarantees. The journal stores ordered facts; applications own
domain data, credentials, and external transactions.
