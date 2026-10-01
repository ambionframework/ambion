# Recorded Codex events

Each `.jsonl` file holds one raw `ThreadEvent` on each line. It comes from
a real `codex` 0.155.1, through `@openai/codex-sdk` 0.155.1, on the model
`gpt-5.6-luna` at medium reasoning effort. The unit tests read it, so the
tests check the mapping against what Codex sends.

| File                 | The run                 |
| -------------------- | ----------------------- |
| `plain-answer.jsonl` | One answer with no tool |

To record a run, iterate `thread.runStreamed(prompt).events` and write
`JSON.stringify(event)` for each event.
