# Contributing to Ambion

Repository installation requires Node **>= 26.4** and pnpm 10 because the
CLI includes OpenTUI. The core library retains its Node **>= 22.19** floor.

Ambion is a collaboration kernel for independently owned agents and the
people they serve. Read the [documentation index](docs/README.md) for current
contracts and the [0.1.0 scope](planning/release-0.1.0.md) for release targets.
[The delivery plan](planning/next.md) owns pending work and completion evidence.

```sh
pnpm install
pnpm check      # format, build, typecheck, lint, test — the gate CI runs
pnpm format     # biome --write, then prettier --write
```

Run both before pushing; CI runs the same commands, so a green local check is a
green build.

`pnpm test:live` runs the room on a real model. It needs the key for the
provider in `AMBION_MODEL` (`ANTHROPIC_API_KEY` by default), it costs money,
and `pnpm check` never runs it. CI runs it weekly and on demand
([`docs/toolchain.md`](docs/toolchain.md) §8).

[`docs/toolchain.md`](docs/toolchain.md) specifies how the repository is built,
checked and released. Read it before changing anything under `.github/`,
`scripts/`, or the root configs.

## Releasing

**Complete the release gates before tagging.** The 0.1.0 target includes
pending API, packaging, and consumer checks in the delivery plan. Current
publishing scripts still include the local-development CLI; its release exclusion
requires a packaging change.

Versions move in lockstep across publishable packages.

```sh
pnpm version:set 0.1.0
git commit -am "release: 0.1.0" && git tag v0.1.0 && git push --follow-tags
```

The tag runs `.github/workflows/release.yml`, which re-runs the gate, checks the
tag against the package version, and publishes. Publishing is idempotent —
re-running a failed release finishes it.
