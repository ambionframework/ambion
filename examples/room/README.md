# room

An interactive multi-agent session in your terminal: a working room — an
engineer, a designer, a product manager, an executive, a project manager —
advancing an initiative you bring to it. Each mechanic of
[`docs/agent.md`](../../docs/agent.md) is observable by hand.

```sh
pnpm install && pnpm build      # once, at the repository root
cd examples/room
ANTHROPIC_API_KEY=… pnpm start
```

`AMBION_MODEL` picks the model (default `anthropic/claude-sonnet-4-5`).

## The cast

| Seat       | Status  | What to watch                                                     |
| ---------- | ------- | ----------------------------------------------------------------- |
| `lead`     | idle    | Tech lead managing a team — feasibility, estimates, `team_status` |
| `designer` | idle    | Speaks when the user experience is at stake; otherwise silent     |
| `product`  | idle    | Owns scope and priority; pulls colleagues in with directed says   |
| `exec`     | idle    | Engages only on resources and time to market — then decides       |
| `planner`  | passive | The plan of record: hears nothing until named, keeps it current   |

The room routes its own bookkeeping: when an estimate, a scope change, or a
resource decision lands, whoever made it calls the `planner` in with a
directed say — the passive seat wakes, folds the change into the plan, and
goes back to rest.

## Things worth trying

- **Kick off**: "we are shipping payments v2 this quarter — thoughts?" The
  working seats look; `exec` stays quiet unless resources or dates are on the
  table, and `planner` hears nothing at all.
- **Silence**: ask a purely technical question. `designer` and `exec` glance
  and decline — the dim `· designer stayed quiet` line is an agent choosing.
- **Waking the executive**: ask for two more engineers, or whether the date
  is worth hitting. The seat that ignored everything else now decides.
- **The passive seat**: watch decisions get routed to `planner` by directed
  say, then ask `@planner where are we?` for the plan of record and progress
  summary.
- **Steering**: type a correction while agents are mid-turn. It is injected
  into the running turns — and a say that raced past it fails back and gets
  redone (`· <agent> spoke over the room — retrying`).
- **The record**: `/record` shows who said what, `from` stamped by the
  runtime. `/seats` shows live statuses; `/abort` quiets an active room.
