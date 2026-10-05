# @ambionframework/canvas

The canvas store of an [Ambion](https://ambionframework.com) deployment.
The store keeps one row for each room: the name, the goal, the depth, the
state, and what a start needs. It holds no message, no lease, and no
exchange. The journal of each room stays the source of that room.

The package holds the store, the lifecycle of the rooms, and the tools of
the breakout rooms. The bridge does not exist yet. [The canvas design](../../docs/canvas.md) holds
the contract.

## Install

```sh
pnpm add @ambionframework/canvas @ambionframework/journal @ambionframework/workspace
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

## The lifecycle

```ts
import { openCanvas, sqliteCanvas } from '@ambionframework/canvas';

const canvas = openCanvas({
  name: 'lab',
  runtime,
  store: sqliteCanvas(sql),
  workspace,
  breakout: { team: ['scout'] },
  onError: (failure) => console.error(failure.room, failure.operation),
});
await canvas.resume({ agents: [planner, writer, scout] });
const room = await canvas.open({ name: 'site', goal: 'Plan the site.', agents: ['planner'] });
```

| Call                   | Effect                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `resume({ agents })`   | Takes the definitions once. Starts or resumes each running root room, then each running breakout room under a live parent |
| `open(options)`        | Writes a root row and starts the room. A root row that exists returns its handle                                          |
| `start(name)`          | Sets the row to `running` and starts the room. A root starts its running breakout rooms                                   |
| `stop(name)`           | Sets the row to `stopped`, stops the room, then its mirror                                                                |
| `archive(name, close)` | Records the close of a breakout room, then stops it                                                                       |
| `close()`              | Stops every handle. Each row keeps its state                                                                              |
| `room(name)`           | The live handle of a room, or `undefined`                                                                                 |
| `rooms()`              | The rows                                                                                                                  |
| `subscribe(listener)`  | Hears `opened`, `started`, `stopped`, and `archived`                                                                      |

**Each room receives its own definitions.** A root room receives the
definitions in its `agents`, or every definition outside the worker team. A
breakout room receives the definitions of its row, at `broadcast`, with no
assistant, no summary writer, an empty reserve, and `seating: false`.

**The canvas runs the calls on one room name in order.** A refusal is an
`AmbionError` with the code `refused`. A start that fails goes to `onError`,
and its row stays `running`. With a `workspace`, the canvas attaches
`workspace.mirror(room)` after each start. A failed attach goes to
`onError`, and the room runs.

## The tools

```ts
const opener = canvas.tools(); // breakout, tell, archive, and the reminder
const worker = canvas.workerTools(); // report
```

| Tool       | Bundle | Effect                                                                          |
| ---------- | ------ | ------------------------------------------------------------------------------- |
| `breakout` | Opener | Opens `<parent>-<name>`, seats workers of the team, and posts the first message |
| `tell`     | Opener | Posts into a running breakout room that the caller opened                       |
| `archive`  | Opener | Records `done` or `failed`, then stops the room                                 |
| `report`   | Worker | Posts into the parent room, to the opener, with the label `breakout <name>:`    |

**Call both bundles before `defineAgent`.** A tool call before `resume`
or after `close` is a refusal. `breakout` checks a repeat, a name held by
another opener, the name rule, the team, and `perOpener`, in that order. The
reminder of the opener bundle lists the breakout rooms of the seat. Each
refusal is an `AmbionError` with the code `refused`.

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
