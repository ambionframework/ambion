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
  claude/       Claude Agent SDK executor: claude() and claudeExecution()
  cloudflare/   Durable Object adapter
  codex/        Codex SDK executor: codex() and codexExecution()
  journal/      append-only journal storage
  just-bash/    workspace bash backends over just-bash, and a git backend in the process
  pi/           Pi executor: pi() and piExecution()
  simulator/    evals: simulate() and the actors that play a person
  workspace/    workspace resource, tool bundles, and backend helpers
  workstation/  workspace bash backend over SSH, one account for each agent
examples/workbench/   Workbench: rooms and an OpenTUI terminal in one process
scripts/        package discovery, versioning, publishing, reports
docs/           design and operational contracts
planning/       the plan for the next release and the backlog
.github/        CI, live, and dev-release workflows
```

The eleven `packages/*` entries are publishable and share a lockstep version.
Examples are private. The package graph is:

```text
ambion ──▶ journal
pi ──▶ ambion
claude ──▶ ambion
codex ──▶ ambion
cloudflare ──▶ ambion, journal, pi
workspace ──▶ ambion
just-bash ──▶ workspace
workstation ──▶ workspace
assistant ──▶ ambion, pi
simulator ──▶ ambion, pi
```

**A test reaches a package that depends on the tested package by relative
path.** The core's tests read the Pi source. The workspace's tests read the
just-bash source and its test support. A manifest dependency would close a
cycle in the graph above. The test config sends the package's own specifiers
to its source, so a test reads one module.

Internal dependencies use `workspace:*`; pnpm rewrites them to the release
version while packing. Two packages get a packed-consumer smoke check that
installs the tarball outside the repository and exercises its built
exports: `scripts/release.mjs verify` installs `@ambionframework/workspace`
with no token and imports its resource entry, and
[`scripts/journal-smoke.mjs`](../scripts/journal-smoke.mjs) does the same
for the journal. The other packages rely on `pnpm run check:packages` for
export and pack-list correctness, and on `pnpm run test` for the built
`dist/**` that `check:types` type-checks against; neither installs a
tarball in an external project the way the two smoke checks do.

The core has four published entries:

- `@ambionframework/ambion` for hosts.
- `@ambionframework/ambion/hosting` for a room and seat separated by a wire.
- `@ambionframework/ambion/conformance` for the transport suite and the
  executor suite.
- `@ambionframework/ambion/testing` for the scripted executor, `settled`, and
  `fakeClock`. It imports no model library. `@ambionframework/pi/testing`
  holds the scripted Pi stream.

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

**A test checks that each import rule refuses what it names.** Biome reads
each group as a gitignore pattern, and a pattern that matches nothing
passes every import in silence. `scripts/import-rules.test.mjs` lints one
probe file for each case in a copy of the tree. Add a case with each new
rule.

## 2. Toolchain choices

| Concern                | Tool                                                       |
| ---------------------- | ---------------------------------------------------------- |
| Workspace and installs | pnpm 10 (`--frozen-lockfile` in CI)                        |
| Task graph             | Turborepo 2                                                |
| Language               | TypeScript 7, strict settings                              |
| Contracts              | LemmaScript 0.6 with Dafny backend                         |
| Bundling               | tsdown, ESM output and `.d.mts` declarations               |
| Tests                  | Vitest 4                                                   |
| Coverage               | `@vitest/coverage-v8`, on demand; the gate does not run it |
| Lint                   | Biome 2; its formatter is disabled                         |
| Formatting             | Prettier 3; 100-column, tabs in code, spaces in Markdown   |
| Dead code              | Knip 6                                                     |

Every library package requires Node `>=22.19.0`. `examples/workbench`
requires Node `>=26.4.0`, the OpenTUI floor; it also runs on Bun `>=1.3`. CI
tests both floors: Node `22.19.0` for the library packages, Node `26.4.0`
for the library packages and `examples/workbench` together.

## 3. Supply chain

`pnpm-workspace.yaml` deliberately sets `minimumReleaseAge: 1440` (24 hours)
and an empty `onlyBuiltDependencies` allowlist. Do not bypass either setting
without a reviewed reason. CI uses `--frozen-lockfile`, and workflow checkouts
set `persist-credentials: false`.

Two channels publish under the `@ambionframework` scope: dev builds to
GitHub Packages and official releases to npmjs (section 9). The token comes
from `NODE_AUTH_TOKEN` in the environment. Never commit it. No script writes it
to a file or passes it in an argument. CI holds no npmjs token.

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
| `pnpm check:types`           | Type-check every package after its build                               |
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
| `pnpm publish:packages`      | Pack or publish to one channel (`--channel dev` or `release`)          |

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

`scripts/setup.sh` provisions the full local toolchain. It installs Node
26.4.0 through nvm, the development version, because `examples/workbench`
depends on `@opentui/core`, which sets that engine floor. Every library
package needs only Node 22.19.0; the development version covers both. The
script also installs .NET 8, Dafny 4.11, and Z3 4.12.1, which `pnpm
check:lemmascript` reads. It then installs the workspace dependencies. The
script is idempotent, so a second run skips a tool that is already present.
On the web, the SessionStart hook at `.claude/hooks/session-start.sh` runs
the script, and the tool paths reach every later shell through
`CLAUDE_ENV_FILE`.

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

CI runs on pushes to `main`, pull requests, and manual dispatch. It has four
repository jobs plus the LemmaScript reusable workflow:

| Job                  | Checks                                                                    |
| -------------------- | ------------------------------------------------------------------------- |
| `check`              | format, types, lint, Knip, and package hygiene, on Node 26.4.0            |
| `test`               | scripted tests on Node 26.4.0, library packages and `examples/workbench`  |
| `test-library-floor` | scripted tests on Node 22.19.0, library packages only                     |
| `workstation`        | the workstation integration tier against OpenSSH, with root on the runner |

`test-library-floor` removes `examples/workbench` from its checkout before
`pnpm install`. That package depends on `@opentui/core`, which needs Node
`>=26.4.0` for its FFI bridge to native Zig. Deleting the directory keeps
pnpm from building or testing it, but `pnpm-lock.yaml` still lists it as
an importer, so `--frozen-lockfile` still counts it in the workspace scope
and still checks `@opentui/core`'s `engines.node` before it installs
anything. The job installs with `--config.engine-strict=false` to get past
that one check. No library dependency needs more than Node `22.19.0`, and
the test run below is the real proof of that floor.

The `check` job also runs `pnpm run check:packages` after the build. The check
reads `pnpm-lock.yaml` and every publishable manifest. It fails on more than
one `typebox` version, a CommonJS export, a missing export or types path, a
pack list without `dist`, the README, or the license, a pack list with
source, test, or config files, versions out of lockstep, and a different
`engines.node`. Each package carries a copy of the root `LICENSE`, because
`pnpm pack` does not add the root file. It then packs every package and
verifies version agreement with `node scripts/version.mjs --check` and
`node scripts/publish.mjs --pack-only`.

**The package hygiene check also reads every built file in `dist`.** It
fails on an import of a package that the manifest does not declare in
`dependencies`, `peerDependencies`, or `optionalDependencies`. It also fails
on a bundled region whose source is outside the package's own `src`. tsdown
inlines a package that the manifest declares only in `devDependencies`, so a
runtime import of such a package gives that second finding.

The live workflow runs the same scenarios on a real provider. It runs after a
change lands on `main`, on a weekly schedule, and by dispatch. It does not run
on a pull request, because a real-model run costs money. It runs one
job per harness. The `pi` and `claude` jobs read `ANTHROPIC_API_KEY` and use
`AMBION_MODEL` (the default is `anthropic/claude-sonnet-5`). The `codex` job
reads `CODEX_API_KEY`. The `packages` job runs the live tier of every other
package, with a limit of 90 minutes. It sets `AMBION_THINKING` and
`JUDGE_THINKING` to `medium` for the assistant's evals. With an
`OPENAI_API_KEY` secret, it sets `JUDGE_MODEL` to `openai/gpt-5.6-luna`, so
another model family grades the assistant. The workflow cancels a superseded
run. Run it locally
with:

```sh
pnpm test:live
```

`AMBION_HARNESS` is `pi` (the default), `claude`, or `codex`. It selects the
executor of the live seats. The live workflow runs a matrix on the three
values, and each leg runs the live files of `@ambionframework/ambion` only.
A harness whose secret is empty skips. One separate job runs the live tier of
every other package once, with both keys. Run one harness by hand with
`AMBION_HARNESS=codex pnpm test:live`. The `codex` harness reads
`CODEX_API_KEY` and runs the model `gpt-5.6-luna`.

`@ambionframework/codex` has a live tier of its own. Its files skip when
`CODEX_API_KEY` is unset, and they run on the model `gpt-5.6-luna`. Run one
file with `pnpm --filter @ambionframework/codex run test:live`, which builds
the package first because Codex spawns the built room tools server. See
[Codex](codex.md).

The scripted suite and live tier share invariants. The scripted tier also runs
the failure matrix, process kill, random walk, consistency history, and split
host checks. See [`test/support/invariants.ts`](../packages/ambion/test/support/invariants.ts)
and [`durability.md`](durability.md) for the claims those tests enforce.

## 9. Release and publishing

Two channels publish the ten packages under the `@ambionframework` scope.

| Channel | Registry                     | Dist-tag         | Who publishes                 |
| ------- | ---------------------------- | ---------------- | ----------------------------- |
| dev     | `https://npm.pkg.github.com` | `dev`            | CI, on every push to `main`   |
| release | `https://registry.npmjs.org` | `next`, `latest` | The owner, on a local machine |

Versions are lockstep:

```sh
node scripts/version.mjs 0.2.0   # set versions
node scripts/version.mjs --check # verify agreement
```

**Dev builds come from CI.** `.github/workflows/dev-release.yml` runs on a
push to `main` that changes more than Markdown, `docs/`, and `planning/`. It
stamps the version `0.3.0-dev.<run number>.g<sha7>` in the runner and commits
nothing. The base `0.3.0` is the version of the next release and sits in the
workflow file. The `g` prefix keeps the commit identifier from becoming a numeric
identifier with a leading zero, which semver forbids. The job runs the gate,
packs once, and publishes those tarballs to GitHub Packages under `dev` with
the built-in `GITHUB_TOKEN`. A re-run of a failed job keeps the run number, so
it stamps the same version and skips the packages that a reader already has. It has the permissions `contents: read` and
`packages: write`, and a concurrency group that queues runs.

**Consume a dev build with two `.npmrc` lines.** GitHub Packages needs a token
with `read:packages`, even for a public package.

```ini
@ambionframework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Use an environment variable and never an inline token. Install with
`npm install @ambionframework/ambion@dev`.

**Official releases stay on the owner's machine.** `scripts/release.mjs` has
four commands. Each command is idempotent.

| Command   | What it does                                                                     |
| --------- | -------------------------------------------------------------------------------- |
| `stage`   | Run the guards and the gate, pack once, publish to npmjs under `next`            |
| `verify`  | Install from npmjs outside the repo with no token, and import the resource entry |
| `promote` | Run `npm dist-tag add` to set `latest` on every package                          |
| `status`  | Print the dist-tags of every package                                             |

`stage` refuses when the tree is dirty. It also refuses when HEAD is not the
commit of the tag `v<version>`, when the versions disagree, or when npmjs holds
every package at that version. A partial earlier run is not a refusal: `stage` skips the
published packages and finishes the rest. Without `--yes` it asks on the
terminal and names each package and version. `--dry-run` runs the guards, the
gate, and the pack, then runs `npm publish --dry-run`. It never reaches the
publish endpoint and needs no token. `--otp <code>` reaches npm on `stage` and
`promote`. `--skip-gate` skips the local gate. Use it only for a commit with
a green CI run, on a machine where a local test fails for a reason of the
platform.

**The token never leaves the environment.** The script reads `NODE_AUTH_TOKEN`
from the environment. It writes a temporary npm user config that holds the text
`${NODE_AUTH_TOKEN}`, hands its path to npm, and deletes it after the command.
No file, log line, or argument list holds the token. `verify` removes the
token and every npm setting from the environment of the consumer.

`scripts/publish.mjs` is the lower layer. `--channel dev` or `--channel release`
picks the registry, and `--registry` overrides it. It packs once and publishes
those exact tarballs. It skips a published `name@version` and supports
`--dry-run`, `--tag`, `--pack-only`, and `--skip-pack`. A release publish needs
`--yes`. `pnpm pack` rewrites workspace dependencies to their release version.

The sequence for a release, once the commit that sets the version is on
`main`:

```sh
git checkout main && git pull
git tag v0.2.0 && git push origin v0.2.0
node scripts/release.mjs stage --dry-run
NODE_AUTH_TOKEN=... node scripts/release.mjs stage
node scripts/release.mjs verify
NODE_AUTH_TOKEN=... node scripts/release.mjs promote --otp <code>
```

**0.2.0 retires two packages.** `@ambionframework/cli` and
`@ambionframework/pi-journal` stay at 0.1.0 on npmjs. Give each one a
deprecation after the promote:

```sh
npm deprecate @ambionframework/cli "Removed in 0.2.0. It has no replacement."
npm deprecate @ambionframework/pi-journal "Removed in 0.2.0. Pass a logger to createRuntime to read what a seat did."
```

The packages carry no provenance attestation.

## 10. Departures from Flue

Ambion keeps the pnpm, Turborepo, Biome, Prettier, Knip, tsdown, and Vitest
shape but supplies its own CI/dev-release workflow and lockstep versioning
script. The release scripts are small, side-effect-free when imported, and
operate on one packed artifact set, so the published bytes are the packed bytes.
