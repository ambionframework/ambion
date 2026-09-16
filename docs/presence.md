# Presence

Presence is the contract for people in a room. The implementation is in
[`room.ts`](../packages/ambion/src/room.ts), with the durable fold in
[`room/presence.ts`](../packages/ambion/src/room/presence.ts) and the message
shapes in [`types.ts`](../packages/ambion/src/types.ts). Read
[`agent.md`](agent.md) first: presence follows the same journal, routing, and
activation rules as every other message.

The short version: `startRoom` supplies agents, `room.visit` admits a person,
and `leave` records their departure. An arrival is a journal message, so it
can steer work already running and can wake an idle seat configured to watch
presence.

## 1. Two lifetimes

Agent membership and human visits are independent. `agents` is the executable
catalog; `seats` chooses its initial members and attention. A person is admitted
through a visit. Hosts decide what “present” means for their medium and must
reconcile multiple tabs or connections before calling Ambion. The runtime has
no idle timer and a crash writes no departure.

The room can continue between visits. An agent can address a known absent person;
the message remains on the record for their return. Native timers, external
subscriptions, and scheduler ingress are host concerns.

## 2. The goal a room is started with

`goal` is public context for every agent: what the room is trying to accomplish.
It is optional and has no effect on the journal when omitted. It helps a seat
decide whether an arrival matters; the agent's `identity` and instructions
remain its own domain context.

```ts
const room = await startRoom({
  name: 'initiative',
  goal: 'Ship payments v2 this quarter; keep the plan of record current.',
  agents: [lead, designer, planner],
  seats: { lead: 'broadcast', designer: 'presence' },
});
```

Definitions absent from `seats` stay in the reserve. `startRoom` never takes
people. `readRoom` can inspect a name without starting agents or opening a
visit.

## 3. Visiting

```ts
const visit = await room.visit(andrei);
const exchange = await visit.send({ text: 'Anything to flag?' });
await exchange.response();
await visit.leave();
```

Sending belongs to a live visit. The host authenticates the person and supplies
their name and identity; Ambion keeps neither credentials nor a user directory.
One name identifies one participant. A name held by an agent cannot be visited,
and a stopped room accepts no visit.

Messages addressed to an absent person are valid if the record knows that name.
They wait on the journal and are available after the person returns.

## 4. The visit

The public handle is deliberately small: a `human` definition, a live `since`
cursor, `send(input)`, and `leave()`. See the [`Visit` declaration](../packages/ambion/src/room.ts)
for the exact TypeScript signature.

`since` is a live read of the person's latest durable `left` message. It is
`undefined` before the first departure, remains fixed during the visit, and
moves when a later departure lands. A visit does not become usable until its
`arrived` write is confirmed.

Concurrent visits for one name and identity share the same arrival. A different
identity is rejected while the person is present. `leave` is idempotent and
concurrent departures share one operation; retry an uncertain departure using
the same handle. After leaving, `send` rejects. Re-entering creates a new handle.

Use `room.visit(human, { arrive: false })` when an operation requires existing
presence. It returns `undefined` for an absent person and writes no arrival.
The journal serializes this check with presence changes and resolves uncertain
writes first. Identity mismatches and storage failures reject. The default
`room.visit(human)` explicitly enters the room when the person is absent.

Delivery checks presence again at the journal commit boundary, so a stale handle
cannot authorize speech. A delivery admitted before a departure may commit
before it; later deliveries cannot pass the recorded departure.

## 5. Arriving is a message

The record has one message stream. Human presence uses `kind: 'arrived'` and
`kind: 'left'`; agent membership uses `seated` and `unseated`; spoken messages
use `said`; summaries use `summary`. Presence carries no invented text. Its
`from` and identity come from the live visit, and its routing is stored with the
message just like routing for speech.

Presence changes the room's projection before the message is routed: an agent
activated by an arrival sees the person as present, and one activated by a
departure sees them as absent. Only deliberate `visit`, `leave`, `seat`, and
`unseat` operations create these entries. Sequence numbers are monotonic,
strictly ordered journal positions; `messages({ since })` is exclusive and
starts after the supplied position.

See [`roster.md`](roster.md) for the attention scale. A directed delivery wakes
its named seat when the delivery is allowed; a delivery to a `none` seat is
refused. An idle ordinary seat at `broadcast` therefore does not wake for a
bare arrival. A working seat may be steered by messages it did not author,
while a summary wakes no seat.

## 6. Presence

Presence is a fold over the record (`foldPeople`): a person is `present` from
their last arrival until their next departure, otherwise `absent`. The record
also retains identity, preferences, change time, and the departure sequence.
There is no second presence cache to reconcile.

Visiting an already present person writes nothing and returns the same live
visit. Leaving writes one `left`; visiting again writes one new `arrived`.
Names remain addressable after departure and across a resumed room. If a process
crashes, the last durable state remains: the person stays present until the
host confirms departure or the planned stop records it.

## 7. What presence costs

Each presence change is one journal commit. It causes no model call unless an
idle seat has `presence` attention, and it only steers a seat already working.
There is no clock-generated departure or room-wide presence completion wait.
Exchange completion remains the responsibility of the handle returned by
`visit.send`.

## 8. Catch-up

Use the visit's departure cursor to read what came after the person's last
recorded departure:

```ts
const visit = await room.visit(andrei);
const missed = await room.messages({ since: visit.since });
```

The result includes room messages, including speech and presence, in journal
order. The cursor is a message position, so it survives restart with the same
journal. A planned
`room.stop()` records `left` for people still present after queued work drains;
an unplanned process death records nothing, which may widen the next catch-up
window but cannot hide a message.

Catch-up covers the room record. Agent model turns and tool calls live in their
downstream session and are not presence history.

## 9. What agents see

Every activation gets the current clock, goal when configured, roster, people,
and rendered record. The renderer marks each person's presence and places a
divider at their `since` cursor so the agent can see what they have not read.
An arrival is information, not a request: a seat should use it to aim work it
was already doing and should not greet, summarize, or start work merely because
someone entered.

The relevant context is compactly represented like this:

```text
This room exists to: Ship payments v2 this quarter.
The people: andrei (present, has not seen the last 2 messages).
── andrei has not seen anything below this line ──
· andrei arrived
```

The full rendering rules are in [`seat/render.ts`](../packages/ambion/src/seat/render.ts).

## 10. Observing presence

`room.participants()` returns the current agent and human views. A human view
has `kind: 'human'`, `name`, `identity`, and `presence`; an agent view also has
membership status, attention, and its session id. `room.messages()` and
`room.subscribe()` expose presence through the existing message stream. There
is no separate presence event channel.

Subscriptions are live only and do not replay history. Subscribe before reading
with `messages({ since })`, merge an overlap by `seq`, and advance the cursor
only after the client consumes the ordered messages. Recreate the subscription
and visit after a process restart; handles and subscriptions are in-memory.

## 11. What proves it

[`presence.test.ts`](../packages/ambion/test/presence.test.ts) covers durable
arrivals and departures, identity and duplicate-visit rules, routing and
steering, stale handles, cursors, planned stop, replay, and rendered catch-up.
The shared room rules are exercised through visits in
[`room.test.ts`](../packages/ambion/test/room.test.ts). The reconnect procedure
and process-boundary evidence are in [`deployment.md`](deployment.md) and its
linked tests.
