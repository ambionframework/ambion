# Contributing to Ambion

Repository installation requires Node **>= 26.4** and pnpm 10, the OpenTUI
floor. Every package holds the same Node floor. The `ambion dev` client also
runs on Bun **>= 1.3**.

Ambion is a collaboration kernel for agents and humans. Read the
[documentation index](docs/README.md) for current contracts and
[the plan](planning/next.md) for the 0.1.0 scope, the work, and its
evidence. [The backlog](planning/backlog.md) holds everything after.

```sh
pnpm install
pnpm check      # format check, build, typecheck, lint, test
pnpm format     # biome --write, then prettier --write
```

Run `pnpm format` after edits, then `pnpm check` before pushing. CI also verifies
the Dafny contracts, runs the suites on Node 26, and checks the packed CLI
artifacts; local checks do not replace that coverage.

`pnpm test:live` runs the room on a real model. It needs the key for the
provider in `AMBION_MODEL` (`ANTHROPIC_API_KEY` by default), it costs money,
and `pnpm check` never runs it. CI runs it after a change lands on `main`, on a
weekly schedule, and on demand, and never on a pull request; see
[the workflow](.github/workflows/live.yml).

[Toolchain decisions](docs/toolchain.md) explain the package boundaries, test
tiers, and release process. Keep design rationale there; scripts and workflows
are the authority for exact commands.

## Releasing

**Complete the release gates before tagging.** The 0.1.0 target includes
pending API, packaging, and consumer checks in the delivery plan.
The prerelease includes the local development CLI and Cloudflare adapter.
Create projects with `ambion new`; the release workflow publishes matching
package versions.

Versions move in lockstep across publishable packages.

```sh
pnpm version:set 0.1.0
git commit -am "release: 0.1.0" && git tag v0.1.0 && git push --follow-tags
```

The tag runs `.github/workflows/release.yml`, which re-runs the gate, checks the
tag against the package version, and publishes. Publishing is idempotent —
re-running a failed release finishes it.
