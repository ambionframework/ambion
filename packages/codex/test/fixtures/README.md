# Recorded Codex notifications

Each `.jsonl` file holds one `{ method, params }` message on each line. It
comes from a real `codex app-server` 0.159.2, on the model `gpt-5.6-luna`
at medium reasoning effort, behind the scripted Responses endpoint of
`test/responses.ts`. The scripted endpoint sends each reply whole, so the
stream holds no text delta. The unit tests read it, so the tests check the
mapping against what Codex sends.

Two edits keep the file the same on every host. The text of the `userMessage`
item, which holds the whole rendered view, reads `(the rendered view)`. The
`configWarning` that names a missing `bwrap` is out, because it depends on
the host.

| File                   | What it holds                                            |
| ---------------------- | -------------------------------------------------------- |
| `plain-answer.jsonl`   | One answer with a reasoning summary and no tool          |
| `catalog-0.160.1.json` | The entries of `gpt-5.6-luna` and `gpt-5.5` from 0.160.1 |

To regenerate the catalog, run `codex debug models` on the bundled binary
with a temporary `CODEX_HOME`, and keep the entries that the tests use.

To record a run, wrap `spawnAppServer` in a `connect` function that appends
`JSON.stringify({ method, params })` for each notification, drive one pass
with `test/drive.ts`, and apply the two edits above.
