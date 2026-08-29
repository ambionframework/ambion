# Kestrel Yard, Block C

A construction management suite where each product is an agent: a time
tracker, a task list and a materials tracker. Three people share the
workspace — a project manager in the site office, a foreman on the deck with
a phone, and a quantity surveyor at a cost desk.

Each product holds its own state and its own API and knows nothing of the
others' internals. It asks them on the record, the way a person does.

```sh
cd examples/site
ANTHROPIC_API_KEY=… pnpm start   # open it in your terminal
ANTHROPIC_API_KEY=… pnpm demo    # one scripted run, captured as JSON
```

## What to look for

**Opening the workspace wakes one seat, not all of them.** The task list is
seated `attentive`, so it wakes when somebody arrives and checks what is
blocked on them. The other two sit at the default and do not: an arrival asks
nothing, and three products guessing at what it wants is three briefings
nobody requested. Try `/join dan` and watch which seats read it.

**Waking is not answering.** `· shifts read it and stayed idle` is a product
deciding the question was not its own. Those decisions never reach the
record, so the terminal is the only place you see them.

**Presence is context, not a notification.** Leave somebody in the room and
let the timeout pass. The next product to speak knows they stopped reading,
and says so.

**Coming back is a briefing.** `/leave priya`, let the others work, then
`/join priya` and `/missed`. The room marks where each person stopped
reading, so an agent can tell them the one thing that changed rather than
replaying the record.

**The products change the products.** `/api` lists every call they made into
their own data. The task list rewrites due dates and the materials tracker
moves deliveries because the room decided something, not because anyone
typed an edit.

## The files

| File           | What                                                              |
| -------------- | ----------------------------------------------------------------- |
| `workspace.ts` | The products, their APIs and their state; the people and the goal |
| `main.ts`      | The workspace open in your terminal                               |
| `demo.ts`      | One scripted run, written out as JSON for a report                |

The contracts are [`docs/agent.md`](../../docs/agent.md) and
[`docs/presence.md`](../../docs/presence.md).
