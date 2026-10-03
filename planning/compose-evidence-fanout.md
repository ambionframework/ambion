# Compose live evidence

Each table holds the runs of `packages/workspace/test/live/compose.test.ts`.
The model column holds the reasoning level in parentheses.
The tools column lists the direct calls of the seat. Nested calls follow.
Input tokens count the prompt, the cache read, and the cache write.

## pi

| Model                           | Case                             | Tools                                                                                                                                                                                                                                                                                      | Input tokens | Output tokens | Wall time | Outcome          |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ------------- | --------- | ---------------- |
| anthropic/claude-sonnet-5 (off) | chain                            | compose, compose, say (nested: sql, sql, snapshot)                                                                                                                                                                                                                                         | 45119        | 762           | 0.0 s     | passed           |
| anthropic/claude-sonnet-5 (off) | token comparison with compose    | sql, snapshot, say                                                                                                                                                                                                                                                                         | 44290        | 568           | -         | passed           |
| anthropic/claude-sonnet-5 (off) | token comparison without compose | sql, sql, snapshot, say                                                                                                                                                                                                                                                                    | 38354        | 937           | -         | passed           |
| anthropic/claude-sonnet-5 (off) | fan-out with compose             | bash, bash, bash, sql, sql, compose, bash, compose, bash, snapshot, say (nested: sql, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, sql, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, bash) | 180508       | 2495          | 0.3 s     | passed (compose) |
| anthropic/claude-sonnet-5 (off) | fan-out without compose          | bash, bash, bash, bash, sql, sql, sql, bash, snapshot, say                                                                                                                                                                                                                                 | 105117       | 1965          | -         | passed (bash)    |

## claude

| Model                               | Case                             | Tools                                                            | Input tokens | Output tokens | Wall time | Outcome                                                            |
| ----------------------------------- | -------------------------------- | ---------------------------------------------------------------- | ------------ | ------------- | --------- | ------------------------------------------------------------------ |
| anthropic/claude-sonnet-5 (default) | chain                            | sql, snapshot, say                                               | 40103        | 624           | -         | failed: expected [ 'sql', 'snapshot', 'say' ] to include 'compose' |
| anthropic/claude-sonnet-5 (default) | token comparison with compose    | sql, sql, sql, snapshot, say                                     | 60573        | 746           | -         | passed                                                             |
| anthropic/claude-sonnet-5 (default) | token comparison without compose | sql, sql, sql, sql, snapshot, say                                | 52116        | 825           | -         | passed                                                             |
| anthropic/claude-sonnet-5 (default) | fan-out with compose             | bash, sql, sql, sql, compose, read, snapshot, say (nested: bash) | 99276        | 1928          | 0.1 s     | passed (compose)                                                   |
| anthropic/claude-sonnet-5 (default) | fan-out without compose          | bash, sql, sql, bash, sql, bash, snapshot, say                   | 61823        | 1324          | -         | passed (bash)                                                      |

## codex

| Model                 | Case                             | Tools                                                                               | Input tokens | Output tokens | Wall time | Outcome                                                                                     |
| --------------------- | -------------------------------- | ----------------------------------------------------------------------------------- | ------------ | ------------- | --------- | ------------------------------------------------------------------------------------------- |
| gpt-5.6-luna (medium) | chain                            | sql, compose, say (nested: sql, snapshot)                                           | 28159        | 411           | 0.0 s     | passed                                                                                      |
| gpt-5.6-luna (medium) | token comparison with compose    | compose, compose, say (nested: sql, sql, snapshot)                                  | 28497        | 481           | 0.0 s     | passed                                                                                      |
| gpt-5.6-luna (medium) | token comparison without compose | sql, sql, snapshot, say                                                             | 23771        | 450           | -         | passed                                                                                      |
| gpt-5.6-luna (medium) | fan-out with compose             | compose, bash, bash, bash, bash, bash, sql, sql, bash, snapshot, say (nested: bash) | 238616       | 1037          | 0.1 s     | failed: expected 'Found 10 drift runs with peak_temp ov…' to match /\b4\b\|four/i (compose) |
| gpt-5.6-luna (medium) | fan-out without compose          | bash, bash, bash, bash, bash, bash, bash, bash, bash, bash, snapshot, say, say      | 305275       | 2209          | -         | failed: expected 'Found 10 drift runs with peak_temp ov…' to match /\b4\b\|four/i (bash)    |
