# Ambion team in Node

This project runs two editable agents in one local room, in one Node
process. The planner makes a plan, the reviewer checks it, and the planner
may write the short closing message the human reads. A local human sends
the questions.

## Start the room

Use Node 26.4 or newer and pnpm 10. The CLI starts OpenTUI with the required
native-runtime flag and hosts the room in the same process.

Install the dependencies, copy the credential example, and set a provider key.

```sh
pnpm install
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY.
pnpm dev
```

The terminal shows the team, the conversation, and a message input. A status
line shows the activity, the cost of the exchange, and the person the room
waits on. Enter sends a question. Ctrl-C closes the interface and the room.

The room keeps its record in `.data/room.db`, a SQLite file. Run `pnpm dev`
again to resume the room with its history. Remove `.data/` to start fresh.

Set `AMBION_MODEL` in `.env` to choose another `provider/model-id` that
Ambion supports. The default is `anthropic/claude-sonnet-5`.

## Files

| File          | What it holds                                                        |
| ------------- | -------------------------------------------------------------------- |
| `src/room.ts` | The two agent definitions, the human, and the room composition       |
| `src/host.ts` | `openHost`: the runtime, the SQLite journal, and the room operations |
| `src/main.ts` | A plain prompt for use without the CLI: `pnpm start`                 |

Edit the instructions in `src/room.ts` and start the room again to test a
change.
