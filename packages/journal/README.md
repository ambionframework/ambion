# @ambionframework/journal

`@ambionframework/journal` serializes an append-only record. It owns the
queue, journal envelope, fencing, idempotency, and conditional commits. A
caller owns entry kinds and body validation.

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
  record: 'note',
  run: 'run',
  accepts: (kind, body): kind is 'note' | 'run' =>
    (kind === 'note' || kind === 'run') && typeof body === 'object' && body !== null,
};

const journals = memoryJournals();
const journal = new Journal(journals.open('weekly'), words);
await journal.commit({ key: 'first', draft: { text: 'Hello.' } });
```

`sqliteJournals(sql)` provides SQLite storage with native compare-and-append.
`memoryJournals()` provides independent in-memory journals for one process.

The optional `@ambionframework/journal/pi` subpath opens Pi transcript
sessions over named native journal storage. `piSessions(journals)` gives Pi
each session a separate name in the same backend. The runtime uses this view
for seat audits. Workspace files use their separate workspace backend.

See `docs/durability.md` for the failure contract.
