# @ambionframework/cli

**This package is a version-reporting CLI with a project template.** The
`ambion` binary reports its version. The package includes the stage 1 team
template at `templates/team`; the `new` and `dev` commands will use it in a
later stage.

The repository can prepare a standalone copy from local package archives:

```sh
node scripts/prepare-team.mjs /absolute/path/to/new-team
```

Run `pnpm install` in the new directory, then follow its README. The helper
builds local packages and uses their archives without publishing them.

The [0.1.0 release scope](../../planning/release-0.1.0.md#f9-distribution-and-developer-experience)
still excludes the CLI's full release experience. The remaining commands are
tracked in [the CLI plan](../../planning/cli.md).

Use the [Ambion library](../ambion) and application-managed hosting.
See [Deployment and recovery](../../docs/deployment.md) for the supported
models and reference implementation.

Apache 2.0.
