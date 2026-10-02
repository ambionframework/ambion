# Camera Chat

A macOS room chat with an agent-managed camera sensor. The conversation uses
Workbench's transcript widgets and colors. A small image-only preview appears
at the top right after the agent connects a camera server and a frame arrives.
While it is visible, the chat column narrows to keep text clear of the image.
Hiding or disconnecting the preview restores the full chat width. Referenced
observation images appear beneath their messages, at the same size as the
preview, and remain available after disconnecting.

The host does not open the camera at startup. Ask:

> Connect the built-in camera and tell me what you see.

The agent forks `templates/camera`, clones it, validates and pushes the saved
code, starts its foreground server through `bash`, reads its READY port, and
calls standard `connect`. It reads scenes through standard `observe` and cites
the retained manifest snapshot. There is no camera-specific observation tool.

## Run on macOS

Install Node 26.4 or newer, pnpm, Git, and FFmpeg. For FFmpeg, use
`brew install ffmpeg`. In the repository root:

```sh
pnpm install
pnpm --filter '@ambionframework-examples/camera-chat^...' build
cd examples/camera-chat
pnpm start
```

The seat runs on [Codex](../../docs/codex.md) and reuses the Codex login of
your Mac. Run `codex login` once, and sign in with ChatGPT or an API key. The
app needs no key of its own, reads no key file, and sets no environment
variable. The seat ignores `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, and
`OPENAI_API_KEY` in your shell, so it never bills an API account. Startup
exits with a message when `~/.codex/auth.json` (or `auth.json` in
`CODEX_HOME`) does not exist. Codex must store the login in that file, because
a login in the macOS keyring does not reach the seat. Startup computes that
login path once, checks it, and passes the same path to the seat. The seat
keeps its own Codex home in `<directory>/codex` and links that login file. It
reads no `config.toml` from `~/.codex`.

The default model is `gpt-5.6-luna` with medium reasoning. `--model <id>`
selects another Codex model. The agent shell receives a fixed set of variables
and no host credential. The shell runs as the signed-in user, so it can read
`~/.codex/auth.json`. macOS may ask for camera permission when the agent
starts the server. Approve access for the terminal application that runs it.

The terminal must advertise Kitty graphics or Sixel support (and pixel
dimensions for Sixel). Startup exits with an error if native images are not
available. There is no text-cell fallback. Capture and model observations use
1280 × 720 PNG frames. Acquisition and preview polling target five frames per
second with no audio. Preview polling alone makes no model requests. Scene
questions send a sampled frame to Codex; they do not send a continuous video
stream.

`pnpm start --list-cameras` lists AVFoundation devices without starting the
room. `pnpm start --device <index>` tells the agent which device to use.
Without that option, the template selects the built-in Mac camera.

## Demo

```sh
pnpm demo
```

Send a message to start the scripted agent. A script in `src/demo.ts` runs the
seat in place of Codex and needs no Codex login. It executes the actual Git,
process, connect, and observe tools against a clone of the camera template.
The cloned server runs with `--demo` and produces a synthetic image. It opens
no physical device and makes no model request. Its reply does not perform
visual inference. The demo also requires macOS. Demo state uses `.data/demo`;
live state uses `.data/live`. `--directory <path>` selects another directory.

## Preview and connection lifetime

The host subscribes to `workspace.sensors` lifecycle events. A successful
camera `connect` opens the image-only preview when its first frame arrives. It
polls the registered connection through the standard sensor client and
verifies PNG digests. It rechecks the server process every two seconds; a link
event hides the preview at once. Preview frames are temporary display data;
standard `observe` retains evidence independently in workspace snapshots.
Inline images resolve those immutable snapshots, so later preview frames do
not change the evidence shown with an answer. The agent's answer should cite
the time of its own observation.

| Key               | Action                                      |
| ----------------- | ------------------------------------------- |
| Enter             | Send a room message                         |
| Shift+Enter       | Insert a newline                            |
| PageUp / PageDown | Scroll the conversation                     |
| Escape            | Hide the preview without disconnecting      |
| Ctrl+P            | Toggle the connected preview                |
| Ctrl+C            | Close the room and stop workspace processes |

Ask the agent to disconnect the camera to call `disconnect({ name: 'camera' })`.
This detaches the link and hides the preview while leaving the server running.
Ask it to turn off or stop the camera to call `cancel` on the process. Process
exit also hides the preview. Reconnecting a running server opens it again.
A host restart restores the room journal, but starts without a sensor link;
ask the agent to start and connect the server again.

The standalone [camera template](templates/camera/README.md) documents runtime,
validation, device selection, readiness, Git source metadata, replacement, and
rollback. It uses no runtime npm dependencies and implements the version 1
[sensor API](../../docs/sensors.md). It buffers recent frames in memory and
advertises no span support. The clone records its own launch source metadata.

## Local backends and storage

Bash commands run directly as the signed-in macOS user. Agent home directories
organize files; they are not an OS sandbox. Shell and network access use the
host's permissions. Use this example with trusted agents.

Git uses local bare repositories and filesystem clone URLs. The backend
supplies `templates/camera` and `templates/camera-notes`. It checks names at
its API boundary, but filesystem access does not enforce per-agent Git push
permissions. The backend seeds a template repository when it is absent. A
`pre-receive` hook refuses a push into a template; the shell can remove it.
The room SQLite journal, Codex home, audit, checkouts, and snapshots stay
under the selected data directory. The Codex home and snapshots can contain
image data.

## Code and validation

| File                      | Responsibility                                          |
| ------------------------- | ------------------------------------------------------- |
| `src/main.ts`             | CLI, Codex login check, room startup, cleanup           |
| `src/host.ts`             | Durable room, Codex seat, workspace tool bundle         |
| `src/login.ts`            | Find the Codex login of the host                        |
| `src/demo.ts`             | Scripted seat for `--demo`                              |
| `src/preview.ts`          | Connection callbacks and standard sensor-client polling |
| `src/reference-images.ts` | Resolve retained images cited by messages               |
| `src/tui.ts`              | Workbench transcript and floating preview               |
| `src/terminal.ts`         | Native graphics requirement                             |
| `src/local-bash.ts`       | Local shell backend and loopback ports                  |
| `src/local-env.ts`        | Local files and `bash` on the workspace port            |
| `src/local-git.ts`        | Template seeding and local repositories                 |
| `templates/camera/`       | Independently runnable, forkable camera server          |

```sh
pnpm check:types
pnpm test
```

Tests run the real clone → validate → launch → connect → observe path with a
scripted agent and synthetic frame. They check retained evidence, connection
and process lifetime, preview visibility, resizing, native image dimensions,
and the standard sensor conformance suite. These tests open no physical camera
and make no live model request.
