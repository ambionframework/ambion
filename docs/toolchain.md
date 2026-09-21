# Ambion toolchain specification

This is the repository guide for building, checking, testing, and releasing
Ambion. The code is a pnpm workspace coordinated by Turborepo. Package and
platform plans live in [the plan](../planning/next.md) and
[the backlog](../planning/backlog.md); they are not API references.

## 1. Repository layout

```text
packages/
  ambion/       runtime library
  assistant/    default assistant agent and behavioral guidance
  cli/          ambion binary and project generator
  cloudflare/   Durable Object adapter
  journal/      append-only journal storage
  pi/           Pi executor: pi(), piExecution(), and the seat transcript audit
  pi-journal/   Pi session persistence over journal storage
  workspace/    filesystem resource and tool bundles
examples/workbench/   Workbench: rooms and an OpenTUI terminal in one process
scripts/        package discovery, versioning, publishing, reports
docs/           design and operational contracts
planning/       the plan, the backlog, the rules to write, and dated evidence
.github/        CI, live, and release workflows
```

The eight `packages/*` entries are publishable and share a lockstep version.
Examples are private. The package graph is:

```text
ambion ──▶ journal
pi ──▶ ambion, journal, pi-journal
pi-journal ──▶ journal
cli ──▶ ambion
cloudflare ──▶ ambion, journal, pi
workspace ──▶ ambion
assistant ──▶ ambion, pi
```

Internal dependencies use `workspace:*`; pnpm rewrites them to the release
version while packing. The CLI and packed-consumer smoke checks exercise the
built exports, so a broken dependency order or export map fails before release.
See [`scripts/cli-team-smoke.mjs`](../scripts/cli-team-smoke.mjs) and
[`scripts/journal-smoke.mjs`](../scripts/journal-smoke.mjs) for detailed
consumer checks.

The core has three published entries:

- `@ambionframework/ambion` for hosts.
- `@ambionframework/ambion/hosting` for a room and seat separated by a wire.
- `@ambionframework/ambion/conformance` for the transport suite.

The core imports no platform modules. Workspace filesystem code owns Node
dependencies; Cloudflare code owns Durable Object integration.

The core separates collaboration from execution. `room-host/` coordinates
the journal and pure decisions under `room/`. Its `room.ts` holds the state
and the phases. `people.ts`, `dispatch.ts`, `waits.ts`, and `control.ts` hold one
mechanism each. `execution/` owns the agent
runner, the executor contract, and rendering. It imports no model library:
`@ambionframework/pi` holds Pi and depends on the core. `room.ts` composes
both behind the public facade.
`biome.jsonc` enforces these import boundaries.

## 2. Toolchain choices

| Concern                | Tool                                                     |
| ---------------------- | -------------------------------------------------------- |
| Workspace and installs | pnpm 10 (`--frozen-lockfile` in CI)                      |
| Task graph             | Turborepo 2                                              |
| Language               | TypeScript 7, strict settings                            |
| Contracts              | LemmaScript 0.6 with Dafny backend                       |
| Bundling               | tsdown, ESM output and `.d.mts` declarations             |
| Tests                  | Vitest 4                                                 |
| Lint                   | Biome 2; its formatter is disabled                       |
| Formatting             | Prettier 3; 100-column, tabs in code, spaces in Markdown |
| Dead code              | Knip 6                                                   |

Every package requires Node `>=26.4`, the OpenTUI floor. The `ambion dev`
client also runs on Bun `>=1.3`. CI installs and tests on Node 26.

## 3. Supply chain

`pnpm-workspace.yaml` deliberately sets `minimumReleaseAge: 1440` (24 hours)
and an empty `onlyBuiltDependencies` allowlist. Do not bypass either setting
without a reviewed reason. CI uses `--frozen-lockfile`, and workflow checkouts
set `persist-credentials: false`.

Releases use GitHub Packages at `https://npm.pkg.github.com` under the
`@ambionframework` scope. Credentials come from `NODE_AUTH_TOKEN` or the
workflow's `GITHUB_TOKEN`; never commit them. The release workflow packs once,
attests those exact tarballs, then publishes them.

## 4. TypeScript configuration

`tsconfig.base.json` is the single compiler configuration. Packages extend it
and add their include paths. The important constraints are `strict`,
`noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`,
`moduleResolution: Bundler`, and `noEmit`. tsdown emits the distributable code.
Source imports use explicit `.ts` extensions and `import type` where required.

## 5. Task graph (`turbo.jsonc`)

```text
build        depends on upstream build; emits dist/**
check:types  waits for package and upstream builds
test         waits for package and upstream builds; no cached outputs
dev          persistent and uncached
```

Type checking and tests consume emitted dependency declarations, matching the
published-consumer path. The graph is defined in [`turbo.jsonc`](../turbo.jsonc).

## 6. Script contract

Use these commands at the repository root:

| Command                      | Purpose                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `pnpm build`                 | Build every package through Turborepo                                  |
| `pnpm check:types`           | Type-check packages after their builds                                 |
| `pnpm test`                  | Run report checks and the scripted Vitest suites                       |
| `pnpm check:format`          | Verify Prettier formatting                                             |
| `pnpm check:lint`            | Run Biome with warnings as errors, then Knip                           |
| `pnpm check:lemmascript`     | Verify every listed rules file and every proofs file with Dafny        |
| `pnpm rule:check <file>`     | Regenerate and verify one rules file and its proofs file               |
| `pnpm check:lemmascript:gen` | Regenerate the Dafny and fail on a stale file                          |
| `pnpm check`                 | Format → build/types → lint → Dafny regeneration → report checks/tests |
| `pnpm format`                | Apply Biome then Prettier                                              |
| `pnpm test:live`             | Run provider-backed live suites                                        |
| `pnpm chaos`                 | Run widened failure sweeps (`AMBION_SEEDS=200`)                        |
| `pnpm version:set <x.y.z>`   | Set all publishable package versions                                   |
| `pnpm publish:packages`      | Pack or publish release artifacts                                      |

LemmaScript source, its generated `.dfy.gen` and `.dfy`, and a hand-written
`.proofs.dfy` are kept together. The `.dfy` equals the generation, so
`npx lsc regen --backend=dafny <file>` after a contract edit is a copy; a
proof the generator cannot write goes in the `.proofs.dfy`, which includes
the generated file. `pnpm check` runs `lsc gen-check`, which regenerates
and fails on a stale file without Dafny; `pnpm check:lemmascript` runs the
proof and `check-extra.sh`, which verifies every proofs file, and needs
Dafny on `PATH`. `pnpm rule:check <file>` does both for one file.

`LemmaScript-files.txt` lists what CI verifies, one `path [timeout] [dafny
flags]` per line. A timeout above 60 turns the batch check into a generation
check with no proof, because CI passes no `--slow`; keep every timeout at 60
or below. A rule that calls `filter` needs `--standard-libraries` in the
flag column. The CI job clones the LemmaScript tools at `ls-ref`, which
must name the `lemmascript` version in `package.json`.
[`formal.md`](formal.md) holds the mechanism, the constructs that lower,
and what a contributor does to change a rule.

`scripts/setup.sh` provisions the full local toolchain. It installs Node 26
through nvm, because `@opentui/core` sets that engine floor. It installs .NET 8,
Dafny 4.11, and Z3 4.12.1, which `pnpm check:lemmascript` reads. It then
installs the workspace dependencies. The script is idempotent, so a second run
skips a tool that is already present. On the web, the SessionStart hook at
`.claude/hooks/session-start.sh` runs the script, and the tool paths reach every
later shell through `CLAUDE_ENV_FILE`.

## 7. Lint and format split

Biome lints and Prettier formats. The key repository rules are no explicit
`any`, Node imports use the `node:` protocol, library source does not log to
stdout, and cognitive complexity is capped at 10 (15 for tests). Knip is part
of the lint gate. A deliberate lint exception should be a local ignore with a
reason.

The room serializes writes through the journal. Pure command decisions and
projections live under `packages/ambion/src/room/`; reconciliation derives
pending work from the projection. The complexity rule protects these
boundaries as well as ordinary functions.

The scripted matrix runs scenarios over memory and SQLite journal storage. The
history and kill scenarios intentionally use storage that survives a process;
the fake clock makes lease and retry cases deterministic.

## 8. Continuous integration (`.github/workflows/ci.yml`)

CI runs on pushes to `main`, pull requests, and manual dispatch. It has three
repository jobs plus the LemmaScript reusable workflow:

| Job     | Checks                                                      |
| ------- | ----------------------------------------------------------- |
| `check` | format, types, lint, and Knip on Node 26                    |
| `test`  | scripted tests on Node 26                                   |
| `cli`   | build, CLI version/help/error behavior, and package packing |

The CLI job drives `packages/cli/bin/ambion.mjs`, verifies versions, rejects an
unknown command, and packs all packages. This checks the artifact users will
run, including package resolution and `files` lists.

The live workflow runs the same scenarios on a real provider. It runs after a
change lands on `main`, on a weekly schedule, and by dispatch. It does not run
on a pull request, because a real-model run costs money. It requires
`ANTHROPIC_API_KEY`, uses `AMBION_MODEL` (the default is
`anthropic/claude-sonnet-5`), and cancels a superseded run. Run it locally with:

```sh
pnpm test:live
```

The scripted suite and live tier share invariants. The scripted tier also runs
the failure matrix, process kill, random walk, consistency history, and split
host checks. See [`test/support/invariants.ts`](../packages/ambion/test/support/invariants.ts)
and [`durability.md`](durability.md) for the claims those tests enforce.

## 9. Release and publishing

All publishable packages use GitHub Packages and the `@ambionframework` scope.
Versions are lockstep:

```sh
node scripts/version.mjs 0.1.0   # set versions
node scripts/version.mjs --check # verify agreement
```

Pack once and publish those exact archives:

```sh
node scripts/publish.mjs --pack-only  # writes dist-release/*.tgz
node scripts/publish.mjs --skip-pack  # publishes the existing archives
```

The publisher is idempotent: it skips an existing `name@version`, supports
`--dry-run` and `--tag`, and can resume after a partial failure. It refuses
version disagreement or a missing token. `pnpm pack` rewrites workspace
dependencies to their release version.

The release workflow runs the full gate before publishing:

```text
install → check:types → check:lint → build → test
        → version agreement → tag/version agreement
        → pack → attest → publish → packed consumer check
```

Tag pushes publish; manual dispatch defaults to a dry run. A real publish
verifies the public install path by installing the exact CLI version, running
`ambion new`, then type-checking and dry-running the generated Worker bundle.

Consumers of the current GitHub Packages registry need authentication:

```ini
@ambionframework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Use an environment variable or CI secret, never an inline token. The stable
public-install registry remains a distribution decision tracked in planning.

## 10. Departures from Flue

Ambion keeps the pnpm, Turborepo, Biome, Prettier, Knip, tsdown, and Vitest
shape but supplies its own CI/release workflows and lockstep versioning script.
The release scripts are intentionally small, side-effect-free when imported,
and operate on one packed artifact set so the attested and published bytes
match.
