# Ambion team on Cloudflare

This project runs two editable agents in one local room. The planner makes a
plan, the reviewer checks it, and the planner may write the short closing
message the human reads. A local human sends the questions.

## Start the room

Use Node 26.4 or newer and pnpm 10. The CLI starts OpenTUI with the required
native-runtime flag and launches Wrangler on loopback.

Install the dependencies, copy the credential example, and set a provider key.

```sh
pnpm install
cp .dev.vars.example .dev.vars
# Edit .dev.vars and set ANTHROPIC_API_KEY.
pnpm dev
```

The terminal shows a compact team header, a full-width conversation, and
message input. A status line shows activity. Errors appear below the
conversation. Enter sends a question. Ctrl-C closes the interface and stops
Wrangler.

Wrangler serves the Worker on `http://127.0.0.1:8787`. The local Durable
Object state stays in `.wrangler/`. Remove that directory to start fresh.

Set `AMBION_MODEL` in `.dev.vars` to choose another `provider/model-id` that
Ambion supports. The default is `anthropic/claude-sonnet-5`.

## HTTP surface

For Worker logs and HTTP-only testing, run `pnpm dev:worker`.
Then start the room and join the human participant:

```sh
curl -X POST http://localhost:8787/start
curl -X POST http://localhost:8787/join
```

`/start` starts or resumes the room. After a restart, the room reads its
history from `.wrangler/`. Run `/join` before sending another question.

Send a question and read the room. The response from `/send` contains the
message sequence of the question in `from`.

```sh
curl -X POST http://localhost:8787/send \
  -H 'content-type: application/json' \
  -d '{"text":"What should we decide first?"}'
curl http://localhost:8787/read
curl 'http://localhost:8787/read?since=SOURCE_SEQUENCE'
```

`/read` returns the detached room read that `readRoom` returns in Node. It
holds the messages, the participants, and every exchange with its outcome
and its cost. `since` is an exclusive cursor: the read then holds only the
messages after that sequence. The terminal of `ambion dev` shows this same
read. `/health` reports Worker readiness.

The two agent definitions are in `src/room.ts`. Edit their instructions and
restart Wrangler to test a change.
