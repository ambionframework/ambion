# @ambionframework/canvas

The canvas store of an [Ambion](https://ambionframework.com) deployment.
The store keeps one row for each room: the name, the goal, the
state, and what a start needs. It holds no message, no lease, and no
exchange. The journal of each room stays the source of that room.

The package holds the store, the lifecycle of the rooms, the tools of the
breakout rooms, the bridge, and the widgets of each room. [The canvas design](../../docs/canvas.md)
holds the contract.

## Install

```sh
pnpm add @ambionframework/canvas @ambionframework/journal
```

The package needs Node 22.19 or newer.

## Use

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
