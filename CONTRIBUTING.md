# Contributing to Ambion

## Setup

Requires Node **>= 22.19** (or >= 23.6) and pnpm 10.

```sh
pnpm install
pnpm check      # build, typecheck, lint, test — the same gate CI runs
```

## Layout

| Path              | What                                            |
| ----------------- | ----------------------------------------------- |
| `packages/ambion` | `@ambionframework/ambion` — the runtime library |
| `packages/cli`    | `@ambionframework/cli` — the `ambion` binary    |
| `scripts`         | Version and publish tooling                     |

Both packages are scaffolding: they build, type-check, pack and publish, and
that is all they do. Examples will live in `examples/`, which the workspace
already globs.

[`docs/toolchain.md`](docs/toolchain.md) specifies how the repository is built,
checked and released. Read it before changing anything under `.github/`,
`scripts/`, or the root configs.

## Working on it

```sh
pnpm build                     # turbo build
pnpm test                      # turbo test
pnpm check:types               # tsc --noEmit everywhere
pnpm check:lint                # biome + knip
pnpm format                    # biome --write, then prettier --write

# Run the CLI from your working copy:
./packages/cli/bin/ambion.mjs --help
```

Run `pnpm format` and `pnpm check` before pushing. CI runs the same commands, so
a green local check is a green build.

## Adding a package

A new package under `packages/` is picked up automatically once it implements
the script contract: `build`, `check:types`, `test`, and optionally `dev`. Extend
`tsconfig.base.json` rather than restating compiler options.

## Releasing

Versions move in lockstep across publishable packages.

```sh
pnpm version:set 0.1.0         # rewrite every publishable manifest
pnpm version:set --check       # verify they agree
git commit -am "release: 0.1.0" && git tag v0.1.0 && git push --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/release.yml`, which re-runs the full
gate, checks that the tag matches the package version, and publishes to GitHub
Packages. Publishing is idempotent — re-running a failed release finishes it.
