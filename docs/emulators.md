# Emulators

**An emulator reproduces another program's behavior in TypeScript, in
process, with no binary and no operating system beneath it.**
`@ambionframework/emulators` implements the
[workspace backend contract](workspace.md#the-resource-contract) over
just-bash: a virtual Unix filesystem and shell with no key and no network.

just-bash is not an approximation. It writes a real filesystem and reads a
real shell grammar; a script that runs there runs the same way on a real
machine. "Emulator" names where it runs, not how faithfully it runs.

## The two backends

**`memoryBackend()` keeps files in process.** Its optional `seed` writes
files before the first use, and `readFiles()` supports host inspection.
Disposal releases its cached filesystem, so a disposed resource does not
recreate a seeded filesystem.

**`directoryBackend(root)` operates on a real directory.** It creates the
root when a backend operation needs it. `destroy()` deletes its contents and
keeps the root directory.

Both backends provide a virtual Unix filesystem and shell for tools, with
JavaScript and Python execution available. Network commands are absent.
just-bash is single-user: agents sharing one resource can read each other's
homes. Neither backend provides operating-system isolation between agents or
distributed ownership of a shared directory. Hosts own credentials and
authorization for external services.

Backends perform raw filesystem I/O below the resource owner. They do not
maintain a second destruction mark or a second operation queue; the
[lifecycle](workspace.md#destroy-a-resource) is the owner's alone.

## The null device

**`/dev/null` discards writes and reads empty on both backends.** A redirect
to it, and a `write` tool call on it, change nothing. The device lives in a
layer above the filesystem, so the directory backend writes no `dev` entry
under its root and the memory backend holds no `/dev` file.

**The standard devices are present on both backends.** `/dev/zero`,
`/dev/stdin`, `/dev/stdout`, `/dev/stderr` and `/dev/fd` exist and read
empty. `/dev/zero` does not stream bytes. `ls /dev` lists the same names on
each backend.

## just-bash as one implementation of the `sql` tool

The [`sql` tool's contract](workspace.md#query-the-shared-database) holds
over any backend that supplies a `sqlite3` command. just-bash is the default
implementation, and it has these specific behaviors:

- **It loads the main database into a WebAssembly engine and writes the file
  back after each call.** The owner's serialization keeps this write-back safe:
  two calls never overlap, so no call loses another's write.
- **`ATTACH` opens `:memory:` only.** The engine has no bridge to the virtual
  filesystem, so `ATTACH` of a second file fails to open it. A cross-file join
  is not available; a cross-database join uses a `:memory:` scratch database.
- **CSV is the bridge to `python3`.** The just-bash `python3` has no `sqlite3`
  module, so a Python script reads an exported CSV file.
- **The tool passes command-line flags.** just-bash `sqlite3` reads flags such
  as `-json` and `-csv`. It does not read dot-commands such as `.mode`.
- **The dialect is SQLite.** Dates are functions, `||` joins text, and a column
  type is an affinity.
