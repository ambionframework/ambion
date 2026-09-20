# @ambionframework/pi-journal

**Store full Pi sessions over named journals.** `piSessions(journals)` returns
a `SessionOpener`. Each session uses a separate, collision-safe storage name.
The package depends on Pi and `@ambionframework/journal`. It needs no Ambion room.

```ts
import { memoryJournals } from '@ambionframework/journal';
import { piSessions } from '@ambionframework/pi-journal';

const journals = memoryJournals();
const sessions = piSessions(journals);
const session = await sessions.open('review', 'parent-session');
const entry = await session.appendEntry(
  { id: 'note', type: 'custom', customType: 'audit', data: { text: 'Ready.' } },
  'main',
);
await session.setLabel(entry.id, 'keep');

const reopened = await piSessions(journals).open('review');
const label = await reopened.getLabel(entry.id); // 'keep'
```

**Use the journal backend that owns your persistence.** `memoryJournals()`
retains data for one process. `sqliteJournals(sql)` stores sessions through
the caller's SQLite connection. Both implement `JournalOpener`.

**The returned value is a Pi `Session`.** Entries, branches, lanes, operation
records, labels, names, metadata, usage statistics, and log queries retain
their Pi behavior. Reopening a session replays its stored mutations.
Conditional appends recover conflicts and lost acknowledgements.

**A transcript records execution.** Ambion keeps accepted collaboration facts
in the room journal. Its executor reports audit failures separately from
model failures. This package provides persistence; its caller owns that policy.
