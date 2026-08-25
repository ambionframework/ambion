# @ambionframework/cli

The `ambion` command line interface.

> **Scaffold.** This package is a placeholder. `dev`, `deploy` and `init` arrive
> with the runtime. What ships today reports its version and exits — enough to
> prove the chain those commands will run through: the Node floor check in
> `bin/ambion.mjs`, the bundled entry point, and `@ambionframework/ambion`
> resolved across the workspace.

```sh
npm install --save-dev @ambionframework/cli

npx ambion --version
npx ambion --help
```

Any other argument exits non-zero rather than pretending to have succeeded.

Node **>= 22.19** (or >= 23.6) is required and checked before any modern syntax
is parsed, because the CLI will load TypeScript workspace files through Node's
own type stripping.

Apache 2.0.
