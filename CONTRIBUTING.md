# Contributing to Ambion

Repository installation for the full gate, including `examples/workbench`,
requires Node **>= 26.4** and pnpm 10, the OpenTUI floor.
`examples/workbench` also runs on Bun **>= 1.3**. Every library package
needs only Node **>= 22.19**.

Ambion is a collaboration kernel for agents and humans. Read the
[documentation index](docs/README.md) for current contracts and
[the plan](planning/next.md) for the 0.4.0 scope, the work, and its
evidence. [The backlog](planning/backlog.md) holds everything after.

```sh
pnpm install
pnpm check      # format check, build, typecheck, lint, test
pnpm format     # biome --write, then prettier --write
```

Run `pnpm format` after edits, then `pnpm check` before pushing. CI also verifies
the Dafny contracts, runs the suites on Node 22.19 and Node 26.4, and checks
the packed package artifacts; local checks do not replace that coverage.

`pnpm test:live` runs the room on a real model. It needs the key for the
provider in `AMBION_MODEL` (`ANTHROPIC_API_KEY` by default), it costs money,
and `pnpm check` never runs it. CI runs it after a change lands on `main`, on a
weekly schedule, and on demand, and never on a pull request; see
[the workflow](.github/workflows/live.yml).

[Toolchain decisions](docs/toolchain.md) explain the package boundaries, test
tiers, and release process. Keep design rationale there; scripts and workflows
are the authority for exact commands.

## Releasing

**Complete the release gates before tagging.** The delivery plan lists the
API, packaging, and consumer checks of the next release. A release publishes
matching package versions.

Versions move in lockstep across publishable packages.

**A push to `main` publishes a dev build.** CI stamps the version
`0.4.0-dev.<run>.g<sha7>` and publishes to GitHub Packages under `dev`.

**The owner publishes an official release from a local machine.** CI holds no
npmjs token.

```sh
pnpm version:set <version>
git commit -am "release: <version>" && git tag v<version>
node scripts/release.mjs stage --dry-run   # guards, gate, pack, npm dry run
NODE_AUTH_TOKEN=... node scripts/release.mjs stage
node scripts/release.mjs verify            # install from npmjs with no token
NODE_AUTH_TOKEN=... node scripts/release.mjs promote
```

Each command is idempotent. A rerun after a failure finishes the release.
[Toolchain section 9](docs/toolchain.md) has the guards and the token rules.
