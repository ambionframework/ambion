# Ambion team

This project runs two editable agents in one local room. The planner makes a
plan. The reviewer checks it. A local human sends the questions.

## Start the room

Install the dependencies, copy the credential example, and set a provider key.

```sh
pnpm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set ANTHROPIC_API_KEY.
pnpm dev
```

Wrangler serves the worker on `http://localhost:8787`. The local Durable
Object state stays in `.wrangler/`. Remove that directory to start fresh.

Set `AMBION_MODEL` in `.dev.vars` to choose another `provider/model-id` that
Ambion supports. The default is `anthropic/claude-sonnet-5`.

## HTTP surface

Start the room and join the human participant:

```sh
curl -X POST http://localhost:8787/start
curl -X POST http://localhost:8787/join
```

Run `/start` once for a new local state. After a restart, the room resumes
from `.wrangler/`; run `/join` again before sending another question.

Send a question and read the record. The response from `/send` contains the
exchange sequence in `from`.

```sh
curl -X POST http://localhost:8787/send \
  -H 'content-type: application/json' \
  -d '{"text":"What should we decide first?"}'
curl http://localhost:8787/messages
curl 'http://localhost:8787/exchange?from=SOURCE_SEQUENCE'
```

Replace `SOURCE_SEQUENCE` with the `from` value returned by `/send`. The
exchange response identifies the exchange with its owner, source sequence,
and timestamp. Read `/messages` for its current record.

The two agent definitions are in `src/room.ts`. Edit their instructions and
restart Wrangler to test a change.
