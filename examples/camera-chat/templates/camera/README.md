# Mac camera sensor

This is a runnable sensor server at protocol version 2. Node 26.4 or newer runs
the TypeScript directly. There are no runtime npm dependencies. `server.ts`
holds the wire contract, and the template owns it. Live capture needs macOS and FFmpeg
installed on the host (`brew install ffmpeg`). macOS camera consent belongs
to the person running the terminal.

Fork `templates/camera` into your own namespace and clone the fork:

```ts
fork({ source: 'templates/camera', name: 'camera', clone: '~/camera' });
bash({ command: 'cd ~/camera && node --test test.ts && git push origin main' });
bash({
  command: 'cd ~/camera && AMBION_SENSOR_REPOSITORY=observer/camera node main.ts',
  name: 'front',
  wait: 1,
  timeout: 86400,
});
```

The template can be newer than your fork. In an existing clone, run `git pull
--no-rebase <url of templates/camera from repos> main`, test, and push.

Use your own fork ID in `AMBION_SENSOR_REPOSITORY`. The process stays in the
foreground; do not use `&`, `nohup`, or daemonize it. Capture starts at launch.
The workspace sets `PORT` for every process, and the server listens on it. The
server prints nothing. Until the first frame arrives, a read answers `503`. A
permission request can delay the first frame.

The process name helps a person read `ps`, such as `front` or `desk`. The
handle that `bash` returns identifies the process. One clone
serves several processes, and each process gets its own `PORT`. Start one
process for each device, with `--device <index>`.

Read the camera with the `observe` macro of the `camera` skill in `skills/`:
`compose({ macro: 'camera/observe', args: { process: '<handle>' } })`. It
reads the index, the observation, and the frame at `/files/<digest>`, and it
checks the digest of the frame. Cite both returned refs. A host that loads no
skill reads the same paths with `fetch({ process: '<handle>', path:
'/camera/observe' })`, then the frame. The host draws the viewfinder after
the agent calls `show` with the handle.

`node main.ts --demo` serves a synthetic frame without opening any device. Use
this flag only for a demonstration. `--device <index>` selects a specific
AVFoundation video device; without it, the server selects the built-in camera.
`--framerate <n>` sets the rate of the AVFoundation input; the default is 30.
The server keeps five frames each second from that input.
`CAMERA_FFMPEG` can name the FFmpeg executable. Capture is 1280 × 720, five
frames per second, with no audio. Timestamps record receipt of the captured
frame. The server compresses one frame at a time on the thread pool. A newer
frame replaces a frame that waits for compression.

**Capture costs CPU and bandwidth.** On the owner's Mac at 1280 × 720, Node
uses about 30% of one core for PNG encoding and FFmpeg uses about 8%. One
frame is a PNG of about 700 KB. The `bash` timeout of the launch command
(86400 seconds above) ends the process after 24 hours. Capture stops then,
and the agent must start the server again.

The server binds only to 127.0.0.1 on `PORT`. It supports `GET /`,
`GET /camera/observe`, and `GET /files/<sha256>`. The last 10 distinct PNG
frames remain in memory. It does not support span reads, persistent
acquisition data, or reconstruction of missed frames. A span query returns
`422`. The workspace keeps what `fetch` reads. Launch source metadata is
frozen at startup, including repository, commit, branch, and dirty status. Keep acquired data and
credentials out of this repo.

Edit `camera.ts` for device selection and sampling, `frame.ts` for resolution,
and `server.ts` for acquisition delivery. Validate with `node --test test.ts`.
Commit and push edits before launching saved code. Stop with `cancel({ handle
})`. For replacement or rollback, cancel the previous process, change the
checkout, and start again with the same process name. Never open two capture
processes for the same device. After a host restart, list the running processes before you start one.
