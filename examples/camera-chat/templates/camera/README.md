# Mac camera sensor

This is a runnable sensor API version 1 server. Node 26.4 or newer runs the
TypeScript directly. There are no runtime npm dependencies. Imports of the
Ambion sensor types are erased by Node. Live capture needs macOS and FFmpeg
installed on the host (`brew install ffmpeg`). macOS camera consent belongs
to the person running the terminal.

Fork `templates/camera` into your own namespace and clone the fork:

```ts
fork({ source: 'templates/camera', name: 'camera', clone: '~/camera' });
bash({ command: 'cd ~/camera && node --test test.ts && git push origin main' });
bash({
  command: 'cd ~/camera && AMBION_SENSOR_REPOSITORY=observer/camera node main.ts',
  name: 'camera',
  wait: 1,
  timeout: 86400,
});
```

Use your own fork ID in `AMBION_SENSOR_REPOSITORY`. The process stays in the
foreground; do not use `&`, `nohup`, or daemonize it. Capture starts at launch.
Read `status({ handle })` until output contains `READY {"port":...}`. READY is
printed only after the first usable frame. A permission request can delay it.
Then call `connect({ name: 'camera', process: handle, port })`, followed by
`observe({ sensor: 'camera/camera' })`. Cite the returned manifest snapshot ref.
A successful camera connection also opens the host's preview.

`node main.ts --demo` serves a synthetic frame without opening any device.
Use this flag only for a demonstration. `--device <index>` selects a specific
AVFoundation video device; without it, the server selects the built-in camera.
`CAMERA_FFMPEG` can name the FFmpeg executable. Capture is 1280 × 720, five frames
per second, with no audio. Timestamps record receipt of the captured frame.
The server compresses one frame at a time on the thread pool. A newer frame
replaces a frame that waits for compression.

The server binds only to 127.0.0.1 on a random port. It supports `GET /`,
`POST /camera/observe`, and `GET /files/<sha256>`. The last 60 distinct PNG frames
remain in memory. It does not support span reads, persistent acquisition data,
or reconstruction of missed frames. The workspace retains observed evidence.
Launch source metadata is frozen at startup, including repository, commit,
branch, and dirty status. Keep acquired data and credentials out of this repo.

Edit `camera.ts` for device selection and sampling, `frame.ts` for resolution,
and `server.ts` for acquisition delivery. Validate with `node --test test.ts`.
Commit and push edits before launching saved code. Stop with `cancel({ handle })`.
For replacement or rollback, cancel the previous process, change the checkout,
start again, read its new port, and reconnect. Never open two capture processes
for the same device. A host restart requires starting and connecting again.
