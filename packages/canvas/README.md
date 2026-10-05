# @ambionframework/canvas

The canvas store of an [Ambion](https://ambionframework.com) deployment.
The store keeps one row for each room: the name, the goal, the depth, the
state, and what a start needs. It holds no message, no lease, and no
exchange. The journal of each room stays the source of that room.

The package holds the store alone. The lifecycle, the tools, and the bridge
do not exist yet. [The canvas design](../../docs/canvas.md) holds the
contract.

## Install

```sh
pnpm add @ambionframework/canvas @ambionframework/journal
```

The package needs Node 22.19 or newer.

## Use

```ts
import { memoryCanvas, sqliteCanvas } from '@ambionframework/canvas';

const store = sqliteCanvas(sql);
await store.insert({
  name: 'site',
  goal: 'Plan the site.',
  depth: 0,
  state: 'running',
  start: { kind: 'root', agents: ['planner'] },
});
await store.setState('site', 'stopped');
console.log(await store.list());
```

`sqliteCanvas` takes the `Sql` that `sqliteJournals` takes. It creates the
table `canvas_rooms` when the table is absent. A host can share one `Sql`
between the two.

## The store

| Call                   | Effect                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| `list()`               | Returns every row in the order of insertion                               |
| `insert(room)`         | Writes the row and returns `inserted`. A taken name returns `exists`      |
| `setState(name, to)`   | Sets the row to `running` or `stopped`                                    |
| `archive(name, close)` | Sets the row to `archived` with its close, and returns the recorded close |

**An archived row is permanent.** `setState` on an archived row throws, and
a repeat `archive` returns the first close. `setState` and `archive` on a
name with no row throw an error that names the room. A repeat `insert`
keeps the old row.

## Conformance

`canvasStoreConformance` runs the same cases over any store. A runner names
and awaits each case.

```ts
import { canvasStoreConformance } from '@ambionframework/canvas/conformance';
import { memoryCanvas } from '@ambionframework/canvas';
import { describe, it } from 'vitest';

describe('memoryCanvas', () => {
  for (const c of canvasStoreConformance({
    name: 'memory',
    open: () => ({ store: memoryCanvas() }),
  })) {
    it(c.name, c.run);
  }
});
```
