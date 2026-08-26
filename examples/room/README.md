# room

An interactive multi-agent session in your terminal: three agents, one room,
you. Each mechanic of [`docs/agent.md`](../../docs/agent.md) is observable by
hand.

```sh
pnpm install && pnpm build      # once, at the repository root
cd examples/room
ANTHROPIC_API_KEY=… pnpm start
```

`AMBION_MODEL` picks the model (default `anthropic/claude-sonnet-4-5`).

## The cast

| Seat         | Status  | What to watch                                            |
| ------------ | ------- | -------------------------------------------------------- |
| `pragma`     | idle    | Answers; calls the archivist in with a directed say      |
| `contrarian` | idle    | Speaks only to disagree — silence is its normal outcome  |
| `archivist`  | passive | Hears nothing until named: `@archivist …` or a colleague |

## Things worth trying

- **Silence**: ask a plain question. `pragma` answers; `contrarian` glances and
  stays quiet — the dim `· contrarian stayed quiet` line is an agent declining.
- **Engagement**: state a bad plan ("let's rewrite the backend in a weekend").
  The same seat that stayed quiet now speaks.
- **The passive seat**: `@archivist what did we decide about X?` — the only
  ways to reach it are a directed delivery or a colleague's directed say. Ask
  `pragma` something historical and watch it call the archivist in.
- **Steering**: type again while agents are mid-turn. The message is injected
  into the running turns — watch the replies fold it in.
- **The record**: `/record` shows who said what, `from` stamped by the
  runtime. `/seats` shows live statuses; `/abort` quiets an active room.
