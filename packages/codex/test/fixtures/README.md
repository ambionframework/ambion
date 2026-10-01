# Recorded Codex events

Each `.jsonl` file holds one raw `ThreadEvent` on each line. It comes from
a real `codex` 0.155.1, through `@openai/codex-sdk` 0.155.1, on the model
`gpt-5.6-luna` at medium reasoning effort. The unit tests read it, so the
tests check the mapping against what Codex sends.

The event streams stay as recorded on 0.155.1. The package now pins
0.158.0, and nobody has recorded them again on that version.

| File                   | What it holds                                            |
| ---------------------- | -------------------------------------------------------- |
| `plain-answer.jsonl`   | One answer with no tool, recorded on 0.155.1             |
| `catalog-0.158.0.json` | The entries of `gpt-5.6-luna` and `gpt-5.5` from 0.158.0 |

To regenerate the catalog, run `codex debug models` on the bundled binary
with a temporary `CODEX_HOME`, and keep the entries that the tests use.

To record a run, iterate `thread.runStreamed(prompt).events` and write
`JSON.stringify(event)` for each event.
