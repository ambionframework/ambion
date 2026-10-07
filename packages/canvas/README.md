# @ambionframework/canvas

The canvas store of an [Ambion](https://ambionframework.com) deployment.
The store keeps one row for each room: the name, the goal, the depth, the
state, and what a start needs. It holds no message, no lease, and no
exchange. The journal of each room stays the source of that room.

The package holds the store, the lifecycle of the rooms, the tools of the
breakout rooms, the bridge, and the widgets of each room. [The canvas design](../../docs/canvas.md)
holds the contract.

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
| `subscribe(listener)`  | Hears `opened`, `started`, `stopped`, `archived`, `widget`, and `answered`                                                |
| `widgets(room)`        | The current revision of each widget of a room, hidden ones included                                                       |
| `revision(id)`         | One widget revision by id, or `undefined`                                                                                 |
| `answers(room)`        | The seq and the person of the act that answers each answered revision of a room                                           |
| `act(person, act)`     | Checks an act, then sends it as a message of the person through the visit of that room                                    |

**Each room receives its own definitions.** A root room receives the
definitions in its `agents`, or every definition. A
breakout room receives the definitions of its row, at `broadcast`, with no
assistant, no summary writer, an empty reserve, and `seating: false`.

**The canvas runs the calls on one room name in order.** A refusal is an
`AmbionError` with the code `refused`. A start that fails goes to `onError`,
and its row stays `running`. With a `workspace`, the canvas attaches
`workspace.mirror(room)` after each start. A failed attach goes to
`onError`, and the room runs.

## The tools

```ts
const bundle = canvas.tools(); // breakout, tell, archive, report, and the reminder
```

| Tool       | Effect                                                                                |
| ---------- | ------------------------------------------------------------------------------------- |
| `breakout` | Opens `<parent>-<name>`, seats definitions of the canvas, and posts the first message |
| `tell`     | Posts into a running breakout room that the caller opened                             |
| `archive`  | Records `done` or `failed`, then stops the room                                       |
| `report`   | Posts into the parent room, to the opener, with the label `breakout <name>:`          |

**Call `tools()` before `defineAgent`.** A tool call before `resume`
or after `close` is a refusal. `report` works in a breakout room alone, and
`breakout`, `tell`, and `archive` work in a root room alone. `breakout`
checks a repeat, a name held by another opener, the name rule, the agents,
and `perOpener`, in that order. In a breakout room, the reminder names the
opener, the parent, and the goal. In a root room, it lists the breakout
rooms of the seat. Each refusal is an `AmbionError` with the code `refused`.

## The widgets

```ts
const canvas = openCanvas({
  name: 'lab',
  runtime,
  store,
  widgets: {
    kinds: [
      {
        name: 'frame',
        description: 'The newest frame of a process.',
        sources: ['process'],
        actions: true,
      },
    ],
  },
});
const viewer = canvas.widgetTools(); // show, hide, and the reminder
```

| Tool   | Effect                                                                                 |
| ------ | -------------------------------------------------------------------------------------- |
| `show` | Writes a new `shown` revision. Equal content of a shown widget writes nothing          |
| `hide` | Writes a new `hidden` revision. A hidden widget changes nothing. An unknown name fails |

**A widget is a live view that an agent places in a room.** The canvas holds
the pointer to the data and reads no source. The host draws the widget.
`widgetTools()` is a refusal when `widgets.kinds` is absent or empty. A `show`
checks the name, the title, the kind, and the source against the catalog. A
process source is `{ type: 'process', handle, path }`: the handle of a process
of the agent, and a path that the process serves on its port.

**The canvas keeps every revision.** `resume` loads them, so `widgets(room)`
and `revision(id)` are synchronous. Each write emits a `widget` event. The
reminder lists the shown widgets of the room, ten at most. The calls of one
room run one at a time.

**A widget can carry actions.** `show` takes `actions` and `for` on a kind
with `actions: true`. A person presses an action, and the host calls
`canvas.act(person, act)`. The canvas checks the press, then sends it as a
message of the person to the author of the widget. An action with `once`
answers its revision, and `answers(room)` reads the answers from the journal.
[Widgets](../../docs/widgets.md#the-acts) holds the contract.

## The bridge

**The bridge carries each finished exchange of a breakout room to the
opener.** An exchange with a `report` needs nothing more. An exchange with no
`report` gets a close notice in the parent room, with the key
`breakout:<name>:<from>`. The notice goes to the opener when the opener sits on the
roster at an attention other than `none`. Otherwise it has no `to`.

**The bridge posts for one parent in order.** A parent with no live handle
gets no post. Each `resume` runs one pass over every breakout row of the live
parents, and each `start` over the breakout rows of that parent, stopped rows
included. A pass skips archived rows,
reads a stopped journal with `readRoom`, and starts no worker. A failed post
goes to `onError` with the operation `notice`, and the next pass posts it.

## The store

| Call                   | Effect                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| `list()`               | Returns every row in the order of insertion                               |
| `insert(room)`         | Writes the row and returns `inserted`. A taken name returns `exists`      |
| `setState(name, to)`   | Sets the row to `running` or `stopped`                                    |
| `archive(name, close)` | Sets the row to `archived` with its close, and returns the recorded close |
| `revisions()`          | Returns every widget revision in the order of insertion                   |
| `appendRevision(w)`    | Appends one revision. A revision id that exists returns `exists`          |

**An archived row is permanent.** `setState` on an archived row throws, and
a repeat `archive` returns the first close. `setState` and `archive` on a
name with no row throw an error that names the room. A repeat `insert`
keeps the old row. `sqliteCanvas` keeps the widget revisions in the table
`canvas_widget_revisions`. A revision never changes.

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
