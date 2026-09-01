# Ambion toolchain specification

This document is the contract for how the Ambion repository is built, checked,
and released. It is meant to be read before the code: everything below is
already implemented, so if a script and this document disagree, that is a bug in
one of them.

The structure follows [withastro/flue](https://github.com/withastro/flue) —
pnpm workspaces driven by Turborepo, Biome for linting, Prettier for formatting,
Knip for dead-code detection, tsdown for bundling, Vitest for tests — with two
deliberate departures noted in [§10](#10-departures-from-flue).

---

## 1. Repository layout

```
ambion/
├── packages/
│   ├── ambion/            @ambionframework/ambion   — the runtime library
│   └── cli/               @ambionframework/cli      — the `ambion` binary
├── examples/
│   └── site/              the runnable example: a multi-agent room
├── scripts/
│   ├── packages.mjs       shared, side-effect-free: finds the publishable packages
│   ├── version.mjs        set/verify the single version across them
│   └── publish.mjs        idempotent publish to GitHub Packages
├── docs/toolchain.md      this document
├── .github/workflows/     ci.yml, release.yml
├── turbo.jsonc            task graph
├── tsconfig.base.json     the one set of compiler options
├── biome.jsonc            lint rules (formatter disabled)
├── prettier.config.js     formatting
├── knip.json              unused code/dependency detection
└── pnpm-workspace.yaml    packages/*, examples/*
```

**Rule.** `packages/*` is publishable. `examples/*` is private and exists to
be run. `examples/site` is the runnable example; the gate type-checks it with
everything else, so an example that breaks fails the build.

### Package graph

```
@ambionframework/cli  ──depends on──▶  @ambionframework/ambion
```

Internal dependencies use `workspace:*` and are rewritten to the published
version by pnpm at pack time. That one edge is what the scaffold exercises:
the CLI's help text reads a constant out of the runtime package, so the smoke
test fails if turbo builds them out of order, if the `exports` map is wrong, or
if the workspace protocol does not resolve.

### What the packages do

`@ambionframework/ambion` is the runtime; [`agent.md`](agent.md),
[`presence.md`](presence.md) and [`assistant.md`](assistant.md) are its contracts.
`@ambionframework/cli` is the `ambion` binary; it currently reports its
version and nothing else.

---

## 2. Toolchain choices

| Concern         | Tool                  | Why this one                                                         |
| --------------- | --------------------- | -------------------------------------------------------------------- |
| Package manager | **pnpm 10**           | Workspace protocol, strict `node_modules`, `--frozen-lockfile` in CI |
| Task runner     | **Turborepo 2**       | Declares the build→typecheck→test order once; content-hash caching   |
| Language        | **TypeScript 7**      | `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`         |
| Bundler         | **tsdown** (rolldown) | ESM-only output plus `.d.mts`, one config per package                |
| Tests           | **Vitest 4**          | Runs TypeScript sources directly; no build step for the inner loop   |
| Lint            | **Biome 2**           | Fast; formatter switched off so it never fights Prettier             |
| Format          | **Prettier 3**        | Tabs, single quotes, width 100, trailing commas                      |
| Dead code       | **Knip 6**            | Catches unused exports and undeclared dependencies                   |

### Version floor

Node **>= 22.19**. The floor tracks Node's own type stripping: it is on by
default from 22.18 and from 23.6, so 23.0–23.5 is explicitly excluded.
`packages/cli/bin/ambion.mjs` enforces the floor at runtime, before any modern
syntax is parsed.

---

## 3. Supply chain

The registry is the softest part of any JavaScript toolchain, so the defaults are
tightened in four places.

**Quarantine new releases.** `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`
— refuse any version published in the last 24 hours. Account-compromise attacks
on npm are typically caught and yanked within hours, so a short quarantine turns
"we shipped the malicious release" into "we never resolved it".

One consequence worth knowing: a dependency floor pinned to a same-day release
cannot resolve, because no satisfying version is old enough. That is the gate
working as designed. The fix is to widen the floor (this is why `@types/node`
is `^26.2.0` and not `^26.3.0`); adding the package to
`minimumReleaseAgeExclude` defeats the gate.

**Block install scripts.** pnpm 10 refuses to run `preinstall`/`install`/
`postinstall` unless a package is allowlisted. `onlyBuiltDependencies` is the
deliberate exception set and is currently **empty** — nothing in the tree needs
one. Adding an entry means accepting that package's arbitrary code execution at
install time, so it should be a reviewed change.

**Do not leave credentials lying around.** Every `actions/checkout` step sets
`persist-credentials: false`, so the job token is not written into `.git/config`
where a later step or a compromised dependency could read it. No workflow here
pushes, so nothing needs it.

**Sign what you ship.** The release packs once and attests those exact tarballs
with `actions/attest-build-provenance` before publishing them (see
[§9](#9-release-and-publishing)). Consumers verify with:

```sh
gh attestation verify ambionframework-ambion-0.1.0.tgz --repo ambionframework/ambion
```

Two supporting settings: `engine-strict=true` fails the install immediately
on an unsupported Node; and CI always installs with `--frozen-lockfile`, so a
lockfile that disagrees with the manifests is a build failure.

---

## 4. TypeScript configuration

One file — `tsconfig.base.json` — holds every compiler option. Each package
extends it and adds only `include`. There is no second opinion about strictness
anywhere in the tree.

Notable settings and what they buy:

- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` — the runtime
  indexes into maps and arrays constantly; unchecked access would hide real
  holes.
- `verbatimModuleSyntax` — type imports are always written `import type`, so
  the emitted ESM is exactly what the source says.
- `moduleResolution: Bundler` with `allowImportingTsExtensions` — source files
  import each other as `./runtime.ts`. tsdown resolves these at build time.
- `noEmit` — `tsc` is a checker here. tsdown emits.

---

## 5. Task graph (`turbo.jsonc`)

```
build       dependsOn: ^build            outputs: dist/**
check:types dependsOn: build, ^build     (needs upstream .d.mts)
test        dependsOn: build, ^build
dev         persistent, never cached
```

`check:types` and `test` wait on upstream builds because the CLI type-checks
against the runtime's _emitted_ declarations. That is the same
resolution a published consumer gets, so a broken `exports` map fails here,
before release.

---

## 6. Script contract

Every publishable package implements the same four scripts. A new package that
implements them is picked up by the root commands with no further wiring.

| Script        | Meaning                  |
| ------------- | ------------------------ |
| `build`       | Emit `dist/`             |
| `check:types` | `tsc --noEmit`           |
| `test`        | `vitest run`             |
| `dev`         | Long-running; not cached |

Root commands:

| Command                    | Runs                                           |
| -------------------------- | ---------------------------------------------- |
| `pnpm build`               | `turbo build`                                  |
| `pnpm test`                | `turbo test`                                   |
| `pnpm check:types`         | `turbo run check:types`                        |
| `pnpm check:lint`          | `biome lint . --error-on-warnings` then `knip` |
| `pnpm check:format`        | `prettier . --check`                           |
| `pnpm check`               | build → types → lint → test, in that order     |
| `pnpm format`              | `biome check --write` then `prettier --write`  |
| `pnpm version:set <x.y.z>` | Set one version across publishable packages    |
| `pnpm publish:packages`    | Publish to GitHub Packages                     |

`pnpm check` is what CI runs and what a contributor runs before pushing. There
is one gate, so nothing drifts apart.

---

## 7. Lint and format split

Biome lints; its formatter is **disabled**. Prettier formats. Two tools with one
job each, so `pnpm format` is never a fight.

Rules worth knowing:

- `noExplicitAny: error` repo-wide. The runtime's public surface uses `unknown`
  for message bodies and narrows at the edge.
- `noConsole` is **error inside `packages/ambion/src/**`** and off elsewhere.
  The library will never write to stdout on its host's behalf; a host passes a
  logger in. The CLI and the examples are console programs and are exempt.
- `useNodejsImportProtocol: error` — `node:fs`, never `fs`.
- `noExcessiveCognitiveComplexity: error`, budget **10** — **15** under
  `**/test/**`. Biome ships this rule at `info` with a threshold of 15, which
  is a number nothing checks; here it fails the build like every other rule.
- Knip runs as part of `check:lint`, so an unused export fails the build rather
  than accumulating.
- `--error-on-warnings` does real work. Biome exits `0` on warnings by
  default, which makes a lint step that reports problems and passes anyway —
  exactly how warning backlogs start. Every configured rule is `error`, and
  Biome's own default-warn rules block too. A deliberate exception is a one-line
  `biome-ignore` with a reason; the tree currently has none.

### The complexity budget

Two numbers, and one standard behind them. Biome charges a nested
function for the nesting it sits in, so a branch inside `describe` → `it`
scores three where the same branch in a plain function scores one; on one
budget a test would hit the wall three times sooner than the code it exercises.
The wider budget measures a test body from where it actually starts. A test
that has become a program still fails — the tree's worst test scores 8.

The runtime's densest method, `SessionImpl.dispatch`, sits at exactly 10.
Routing is the room's whole policy and is meant to stay one readable piece, so
it has no headroom on purpose: the next branch added to it forces a
deliberate decision. Everything else
in the tree scores 9 or below.

The budget is a lint rule, so it runs wherever `check:lint` runs — the `check` job on a pull request, and the gate the release
re-runs before it publishes. There was nothing to add to `ci.yml`.

---

## 8. Continuous integration (`.github/workflows/ci.yml`)

Three jobs, on push to `main`, on every pull request, and on demand.

| Job       | What it proves                                                      |
| --------- | ------------------------------------------------------------------- |
| **check** | Formatting, types, lint, the complexity budget, and Knip on Node 22 |
| **test**  | The suite passes on Node 22 **and** 24                              |
| **cli**   | The published artifact actually works                               |

The `cli` job is the one that matters most and the one a unit test cannot
replace. It builds, then drives `packages/cli/bin/ambion.mjs` — the exact file
that ships — to:

1. print `--version` and assert it matches the manifest;
2. print `--help` and assert it contains `@ambionframework/ambion`, which the
   help text can only know by resolving the built runtime package;
3. run an unknown command and assert a non-zero exit, so "does nothing yet"
   never quietly becomes "succeeds at anything";
4. confirm versions agree, then `pnpm pack` every package — the same packing the
   release does, so a broken `files` list fails on a pull request, well
   before publish.

The CLI has no commands yet. What these steps prove is the path every
invocation travels: the Node floor guard in `bin/ambion.mjs`, the tsdown
bundle, and cross-package resolution.

Concurrency is per-ref with `cancel-in-progress`, so a re-push supersedes the
run it replaced. Permissions are `contents: read` and nothing else.

---

## 9. Release and publishing

### Registry

Both packages publish to **GitHub Packages** (`https://npm.pkg.github.com`)
under the `@ambionframework` scope, which must match the repository owner. The
scope mapping lives in the committed root `.npmrc`; credentials never do
(`.npmrc.local` is git-ignored, and CI injects `NODE_AUTH_TOKEN`).

Each package carries:

```json
"publishConfig": { "registry": "https://npm.pkg.github.com", "access": "public" }
```

### Versioning

Lockstep. The CLI and the runtime are cut from one commit and share one version
number. `scripts/version.mjs`:

- `node scripts/version.mjs 0.1.0` rewrites only the `version` line in each
  publishable manifest, so key order and formatting survive review;
- `node scripts/version.mjs --check` fails if the versions have drifted. CI and
  the release workflow both call it.

### Publishing

`scripts/publish.mjs` packs and publishes in two separable steps, because CI
signs the tarballs in between:

```sh
node scripts/publish.mjs --pack-only    # pnpm pack every package into dist-release/
node scripts/publish.mjs --skip-pack    # publish those exact files
```

`pnpm pack` rewrites `workspace:*` to the real version, so the tarball is the
finished artifact. On a dry run the attestation step is skipped: an attestation
is a permanent public claim that these bytes were released, and on a dry run
they were not.

Both scripts are plain CLIs over `scripts/packages.mjs`, which has no top-level
side effects. That separation prevents a real failure — a module that is
both a library and a command runs its command when someone imports it, and
parses the _importer's_ argv while doing so.

The registry comes from each package's `publishConfig.registry`, so the
manifests npm actually reads are the only place it is written down; a package
that disagrees fails the run by name. Attesting the packed tarballs and then
publishing those same files means the signed bytes and the published bytes are
the same bytes; a second `npm pack` at publish time would break that.

The script is **idempotent**: it queries the registry for each `name@version` and
skips what is already there. A release that fails halfway is finished by
re-running it. It refuses to run when versions disagree, and
refuses to publish without a token. `--dry-run` and `--tag` are supported.

### The release workflow (`.github/workflows/release.yml`)

Triggered by pushing a `v*` tag, or manually (defaulting to a dry run).
Permissions are `contents: read` + `packages: write`, and the built-in
`GITHUB_TOKEN` is the credential — no long-lived secret to rotate.

Order of operations, all before anything leaves the machine:

```
install → check:types → check:lint → build → test
        → versions agree → tag matches package version
        → pack → attest provenance → publish the attested tarballs
```

Permissions are `contents: read`, `packages: write`, plus `id-token: write` and
`attestations: write` for the signature.

A tag can be cut from a commit CI never saw, so the release re-runs the full
gate itself. The tag-match step means
`v0.1.0` cannot publish `0.0.9`.

### Consuming a published package

GitHub Packages requires authentication even for reads:

```ini
# .npmrc
@ambionframework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

A classic PAT with `read:packages` is enough to install; in GitHub Actions the
built-in `GITHUB_TOKEN` already has it. The token is referenced by environment
variable, never inlined, so the file stays committable. The README carries the
full walkthrough.

This is the toolchain's biggest open question, and repository visibility does
not resolve it. GitHub Packages gates the npm registry independently of the
repo, and GitHub documents the gate:
"You need an access token to publish, install, and delete private, internal, and
public packages", and of the registries only the Container registry "allow[s]
anonymous access and can be pulled without authentication".

The registry's responses say the same thing. A package published from a public
repository answers an anonymous request with `401` and
`{"error":"authentication token not provided"}`, while a name that does not
exist under the same owner answers `404` and names that owner — so the package
resolves first, and the 401 is purely an auth gate on a package the registry
knows:

```sh
# published from a public repo → 401 authentication token not provided
curl -s -w ' %{http_code}\n' https://npm.pkg.github.com/@github%2frelative-time-element
# same owner, no such package → 404 does not exist under owner "github"
curl -s -w ' %{http_code}\n' https://npm.pkg.github.com/@github%2fno-such-package
```

Every consumer therefore needs a token, which is workable for a private or
invited audience and a poor fit for a public install path. Moving the stable
line to npmjs.com — keeping GitHub Packages for prereleases — is the expected
next step. `publishConfig.access` is already `public`, so the manifests are
correct for that move.

---

## 10. Departures from Flue

Two, both intentional:

1. **CI is fuller.** Flue's public workflows cover contributor approval and PR
   redirection; its build gate lives elsewhere. Ambion needs its own, so
   `ci.yml` and `release.yml` are written here from scratch.
2. **Lockstep versioning with a hand-rolled release script.** Flue versions
   per package with a changelog tool. With two packages that must agree,
   a 90-line idempotent script is easier to audit than a release manager. This is
   the piece most likely to be replaced (Changesets) once the package count
   grows.
