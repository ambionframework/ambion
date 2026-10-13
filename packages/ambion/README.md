# @ambionframework/ambion

**This package is the runtime of Ambion:** rooms, the exchange, the roster,
presence, and the executor contract. The
[repository README](https://github.com/ambionframework/ambion#readme) holds
the positioning, a quickstart that runs, and the package map.

## Install

Use Node **22.19 or later** and ESM. The packages install from npmjs with no
token.

```sh
npm install @ambionframework/ambion @ambionframework/journal @ambionframework/pi
export ANTHROPIC_API_KEY=...
```

`@ambionframework/journal` supplies the storage: `memoryJournals()` for
tests and `sqliteJournals(sql)` for a persistent service.
`@ambionframework/pi` supplies the Pi executor. The Claude Agent SDK and Codex
have the packages `@ambionframework/claude` and `@ambionframework/codex`.
Add `@ambionframework/workspace` for files, processes, and snapshots, and
`@ambionframework/assistant` for the default assistant. A dev build of `main`
installs from GitHub Packages; see
[the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

## Start a room

[The quickstart](https://github.com/ambionframework/ambion#quickstart) shows
a room with two agents and one visit. A release before 1.0.0 may
change an export, a journal body, or a stored format.

## Entry points

| Import                                | Exports                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@ambionframework/ambion`             | `createRuntime`, `startRoom`, `resumeRoom`, `readRoom`, `readExchange`, `defineAgent`, `definePerson`, `defineTool` |
| `@ambionframework/ambion/hosting`     | The execution protocol that an executor package implements, `hostingOf`, and `visitOf`                              |
| `@ambionframework/ambion/testing`     | The scripted executor, a fake clock, and `settled(room)`                                                            |
| `@ambionframework/ambion/conformance` | The conformance suites for executors, ports, and rooms                                                              |
| `@ambionframework/ambion/names`       | `isName` and `NAME_SYNTAX`                                                                                          |

## Read more

- [Documentation index](https://github.com/ambionframework/ambion/tree/main/docs)
- [Deployment and recovery](https://github.com/ambionframework/ambion/blob/main/docs/deployment.md)
- [Workbench example](https://github.com/ambionframework/ambion/tree/main/examples/workbench)
- [Changelog](https://github.com/ambionframework/ambion/blob/main/CHANGELOG.md)

Apache 2.0.
