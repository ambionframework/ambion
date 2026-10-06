# Camera Chat

A macOS room chat with an agent-managed camera. The conversation uses
Workbench's transcript widgets and colors. The room is a root room of a
[canvas](../../docs/canvas.md). The agent places one viewfinder widget in the
room for each camera. A small preview appears at the top right for each
camera while its process runs and a frame arrives, and the previews stack
without overlap. While a preview is visible, the chat column narrows to keep
text clear of the images. Hiding the previews or stopping the cameras
restores the full chat width. Referenced observation images appear
beneath their messages, at the size of a single preview, and remain available
after the camera stops.

Each viewfinder carries one action, "Look now". Press Ctrl+L to choose it,
and press Enter to send it. The agent receives the press as a message of
yours, observes that camera, and answers.

The host does not open the camera at startup. Ask:

> Connect the built-in camera as front, and tell me what you see.

Name each camera to run several, such as "Connect device 1 as desk".

The agent forks `templates/camera`, clones it, validates and pushes the saved
code, and starts its foreground server through `bash` with the name of the camera and
takes the handle from the result. The workspace gives the process a port in
`$PORT`. The agent reads scenes with
the `observe` macro of the camera template, which `compose` runs with the
handle: it reads the index, the observation, and the frame, and it returns the
snapshot refs. The agent cites the refs. The host loads the macro from its own
copy of the template, so an edit of a fork changes nothing that runs. When the camera answers, the
agent calls `show` with the handle to place the viewfinder. There is no camera-specific
observation tool.

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
`OPENAI_API_KEY` in your shell. The login in `auth.json` decides billing. A
ChatGPT login uses your subscription. An API key login (`codex login
--api-key`) bills that key. Startup exits with a message when
`~/.codex/auth.json` (or `auth.json` in `CODEX_HOME`) does not exist. Codex must store the login in that file, because
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

**Capture costs CPU and bandwidth.** On the owner's Mac at 1280 × 720, Node
uses about 30% of one core for PNG encoding and FFmpeg uses about 8%. One
frame is a PNG of about 700 KB. The host tells the agent to start the server
with a `bash` timeout of 86400 seconds. `bash` ends the process after that
timeout, so capture stops after 24 hours. Ask the agent to start the server
again. The camera server accepts `--framerate <n>` for the
device input rate (default 30).

`pnpm start --list-cameras` lists AVFoundation devices without starting the
room. `pnpm start --device <index>` tells the agent which device to use.
Without that option, the template selects the built-in Mac camera.

## Demo

```sh
pnpm demo
```

Send a message to start the scripted agent. A script in `src/demo.ts` runs the
seat in place of Codex and needs no Codex login. It executes the actual Git,
process, and fetch tools against a clone of the camera template.
The cloned server runs with `--demo` and produces a synthetic image. It opens
no physical device and makes no model request. Its reply does not perform
visual inference. The demo also requires macOS. Demo state uses `.data/demo`;
live state uses `.data/live`. `--directory <path>` selects another directory.

## Cameras, names, and process lifetime

The host opens the canvas `camera-chat` over the SQLite file of the room and
declares one widget kind, `frame`: the newest frame that a process serves,
with the source type `process`, and with actions. The observer holds
`canvas.widgetTools()` and no tool to open breakout rooms.

**A widget binds to the handle that the agent passes.** The agent picks a
short name for each camera, such as `front` or `desk`, or uses the name that the
person gives. That name is the name of the widget. The title of the widget is a
label for people, such as "Front door". The preview labels each box with the
name and the title, so the person can say "hide desk". The agent starts the
camera with `bash` and the same name, which helps the person read `ps`, and
nothing binds by it. The agent takes the handle from the `bash` result. After
the camera process answers, the agent calls:

```ts
show({
  name: 'front',
  kind: 'frame',
  source: { type: 'process', handle: 'bash-4f1c9a02d7be', path: '/camera/observe' },
  title: 'Front door',
  actions: [{ id: 'look', label: 'Look now' }],
});
```

**Several cameras run at once.** One clone of the template serves several
processes, because each process gets its own `$PORT`. The agent passes
`--device <index>` for each camera. A process with no `--device` opens the
built-in camera, so a second camera needs another index. Run
`pnpm start --list-cameras` to see the indexes. Never open two processes for
the same device. The agent checks its running processes first and reuses a
process for that camera.

**The preview keeps one binding for each shown `frame` widget** of the room
`camera`, four at most. The preview lists a further widget in the status line
and does not bind it. A binding checks once that the handle belongs to a running process of the
author of its widget, then reads the path of that process by handle. The
preview reads the widgets again on the `started` event of the room and on each
`widget` event. An adopted process keeps its handle, so a restart finds the
widgets in their rows and binds the cameras that still run from an earlier
host run. A `show` with another handle binds the new process.

A timer of each binding reads five times each second. Each read calls
`workspace.fetch` for the path of the widget and then for the frame at
`/files/<digest>`, with no retention. A body over 16 MiB is a failed read. A
failed read shows "Camera starting" with the name of the camera. The `ended`
event of the bound process clears the preview of that widget alone, and the
widget stays until a new `show`. A `hide` of a widget
removes the preview of that name alone. While the person hides the previews
with Escape or Ctrl+P, all timers stop and no read runs. Preview frames are
temporary display data; the agent's `fetch` retains evidence independently in
workspace snapshots. Inline images resolve those immutable snapshots, so later
preview frames do not change the evidence shown with an answer. The agent's
answer cites the time of its own observation and names the camera.

| Key               | Action                                      |
| ----------------- | ------------------------------------------- |
| Enter             | Send a room message                         |
| Shift+Enter       | Insert a newline                            |
| PageUp / PageDown | Scroll the conversation                     |
| Escape            | Hide all previews while cameras run         |
| Ctrl+P            | Toggle all previews                         |
| Ctrl+L            | Take the keys for the actions of a preview  |
| Ctrl+C            | Close the room and stop workspace processes |

**An action sits under its preview.** The terminal draws `ActionsView` of
the workbench under the box of each camera whose widget has actions. One
`ActionPad` holds the state and reads only the widgets that the screen
draws, in screen order. Ctrl+L takes the keys. Up and Down choose an action,
Enter presses it, and Esc leaves.

**The actions take the keys from the composer.** While they hold the keys,
Esc does not hide the previews. PageUp and PageDown still scroll. The
composer takes the keys back when the pad leaves, also when the agent hides
the widget. The pad sends each press through `canvas.act` as the person
`you`. A `stale` result redraws the new revision. A short terminal draws the
first cameras that fit with their action rows.

**Hide and stop are different requests.** "Hide front" calls `hide` on the
widget `front`, and the camera stays on. "Stop front" or "turn off front"
calls `cancel` on the process of `front`, and nothing else: the widget stays
and draws nothing. "Start front again" starts a new process, then calls `show`
with its new handle. Ask about a scene by naming the camera. With several
cameras and no name, the agent asks which one or describes each. A
host restart resumes the room from its canvas row and its journal. The
previews bind the widget rows again by handle against the processes of
`observer`, so they show the cameras that still run from the earlier host run before the
agent acts.

The standalone [camera template](templates/camera/README.md) documents runtime,
validation, device selection, `$PORT`, Git source metadata, replacement, and
rollback. It uses no runtime npm dependencies and implements version 2 of the
[sensor protocol](../workbench/docs/sensors.md). It buffers recent frames in memory and
advertises no span support. The clone records its own launch source metadata.

## Local backends and storage

Bash commands run directly as the signed-in macOS user. Agent home directories
organize files; they are not an OS sandbox. Shell and network access use the
host's permissions. Use this example with trusted agents.

Git uses local bare repositories and filesystem clone URLs. The backend
supplies `templates/camera` and `templates/camera-notes`. It checks names at
its API boundary, but filesystem access does not enforce per-agent Git push
permissions. On every start the backend creates a missing template. It commits the
source of the host onto the tip of a template that differs, so a fork of the
template fast-forwards. A `pre-receive` hook refuses a push into a template;
the shell can remove it.
The room SQLite file holds the journal and the canvas row of the room.
The Codex home, audit, checkouts, and snapshots stay under the selected
data directory. The Codex home and snapshots can contain image data.

## Code and validation

| File                      | Responsibility                                 |
| ------------------------- | ---------------------------------------------- |
| `src/main.ts`             | CLI, Codex login check, room startup, cleanup  |
| `src/host.ts`             | Canvas, durable room, Codex seat, workspace    |
| `src/login.ts`            | Find the Codex login of the host               |
| `src/demo.ts`             | Scripted seat for `--demo`                     |
| `src/preview.ts`          | One binding for each frame widget, polling     |
| `src/reference-images.ts` | Resolve retained images cited by messages      |
| `src/tui.ts`              | Workbench transcript, previews, and actions    |
| `src/terminal.ts`         | Native graphics requirement                    |
| `src/local-bash.ts`       | Local shell backend and loopback ports         |
| `src/local-env.ts`        | Local files and `bash` on the workspace port   |
| `src/local-git.ts`        | Template seeding and local repositories        |
| `templates/camera/`       | Independently runnable, forkable camera server |

```sh
pnpm check:types
pnpm test
```

Tests run the real clone → validate → launch → fetch path with a scripted
agent and synthetic frame. They check retained evidence, the viewfinder
widgets of two cameras, process lifetime, preview visibility, the size limit of a frame,
resizing, and native image dimensions. The template's own `node --test
test.ts` runs the protocol cases. These tests open no physical
camera and make no live model request.
