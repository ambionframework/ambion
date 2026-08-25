# Contributing to Ambion

Requires Node **>= 22.19** (or >= 23.6) and pnpm 10.

```sh
pnpm install
pnpm check      # build, typecheck, lint, test — the gate CI runs
pnpm format     # biome --write, then prettier --write
```

Run both before pushing; CI runs the same commands, so a green local check is a
green build.

[`docs/toolchain.md`](docs/toolchain.md) specifies how the repository is built,
checked and released. Read it before changing anything under `.github/`,
`scripts/`, or the root configs.

## Releasing

Versions move in lockstep across publishable packages.

```sh
pnpm version:set 0.1.0
git commit -am "release: 0.1.0" && git tag v0.1.0 && git push --follow-tags
```

The tag runs `.github/workflows/release.yml`, which re-runs the gate, checks the
tag against the package version, and publishes. Publishing is idempotent —
re-running a failed release finishes it.
