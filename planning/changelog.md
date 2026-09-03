# Changelog

Changes to Ambion, grouped by release. Newest first. **Unreleased** holds
every change since the last release; a release renames that section and
opens a new **Unreleased** above it. [`demos/`](../demos) holds a run
report for a change that warranted one.

Write an entry as a theme, not a merged pull request. State what changed
for somebody building on Ambion, not the mechanism behind it. Group entries
under **Added**, **Changed**, or **Fixed**, and drop a heading with nothing
under it. An internal change — a CI rule, a refactor, a doc rewrite — gets
no entry unless it changes what a person building on Ambion sees.

## Unreleased

### Added

- Five primitives: `defineAgent`, `defineHuman`, `defineTool`,
  `defineWorkspace`, `startSession`. Pi owns the model loop, tools and
  transcript; just-bash owns the filesystem and shell behind a workspace.
- Presence. A person can join or leave a room, and every seat's context
  shows who is in it.
- A workspace per agent: a shared filesystem and shell, in memory or over a
  real directory.
- An assistant, seated automatically at `startSession`. It reads a
  person's preferences and writes the one message they read when the room
  goes quiet.
