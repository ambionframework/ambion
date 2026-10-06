# Actuator controller

This template is a controller for one actuator. It drives a device toward
a target, keeps it there until a deadline, and leaves it safe at every
end. It needs Node 22.19 or newer and Git. `start` also needs `flock`
from util-linux. It has no dependencies. The default device is a
simulated plant, so the template runs with no hardware.

[Actuators](../../docs/actuators.md) states the pattern that this
template follows.

## The files

| File             | Role                                                            | Customize          |
| ---------------- | --------------------------------------------------------------- | ------------------ |
| `controller.mjs` | The harness: stop handlers, deadline, claims, and the event log | No                 |
| `device.mjs`     | The device: `read()`, `drive(output)`, and `safe()`             | Yes                |
| `law.mjs`        | The control law: a PI law with output limits                    | Yes                |
| `config.json`    | Target, tolerance, times, lock, output limits, and gains        | Yes                |
| `plant.mjs`      | A simulated first-order plant with the interface of a device    | Match the real one |
| `finally.mjs`    | The backstop: it calls `safe()` alone                           | Rarely             |
| `start`          | Takes the lock and replaces itself with `node controller.mjs`   | No                 |
| `test/`          | The contract, on the simulated plant, with real signals         | Extend             |

## Fork and validate

Fork the template, clone it into your home, and start a branch:

```ts
fork({ source: 'templates/actuator-controller', name: 'bath-control', clone: '~/bath-control' });
bash({ command: 'cd ~/bath-control && git switch -c pid' });
```

Run the tests after each change. They start the controller as a process,
send real signals, and read the simulated plant:

```sh
cd ~/bath-control && npm test
```

## Customize

1. **Write the driver in `device.mjs`.** `read()` gives the measured value
   of the stock, in `config.unit`. `drive(output)` sets the output.
   `safe()` sets the safe output. `safe()` must be idempotent and must
   need no state from an earlier process.
2. **Measure the stock that the goal names.** A heater loop reads the bath
   thermometer. The heater's power is its output. The controller reads its
   own instrument, and it reads no sensor of the workspace.
3. **Set the plant model in `config.json`.** `sim.tau` is the time
   constant in seconds, and `sim.gain` is the rise for each unit of output
   and second. Match them to a step response of the real plant.
4. **Tune `law.mjs` on the simulated plant.** Set `periodMs` at one tenth
   of the time constant or less.
5. **Set `device` to `hardware`** when the driver is ready.

Commit and push each working version:

```sh
cd ~/bath-control && npm test && git add -A && git commit -m "Tune the PI law" && git push -u origin pid
```

## Start and stop

Start the controller with `bash`. `start` takes the lock in
`config.json`, so a second controller of the same device gives up and
exits 0. Run it as `bash start`, because a fork of a template keeps no
file modes. Give `grace` the seconds that `safe()` needs:

```ts
bash({ command: 'bash ~/bath-control/start', grace: 5, name: 'bath-hold', timeout: 3900, wait: 0 });
```

**A cancel gives the controller its grace.** The workspace sends
`SIGTERM`, waits `grace` seconds, then sends `SIGKILL`. The controller
makes the device safe and exits 0 inside the grace.

**Keep `node` as the only process.** `start` replaces itself with
`node`, so a stop signal reaches the controller directly and its exit
code reaches the workspace. A parent such as `npm start` or a forking
`flock` dies on `SIGTERM` and reports 143 while the controller cleans up.

**Set `timeout` above `holdSeconds`.** The controller ends itself at the
deadline. The timeout of `bash` is a backstop.

**Run `finally.mjs` after an unclean end.** An exit code other than 0, or
a kill after the grace, can leave the device driven. `finally.mjs` makes
it safe, and a second run changes nothing:

```ts
bash({ command: 'cd ~/bath-control && node finally.mjs', wait: 30 });
```

## What the controller promises

| End                               | Exit code | The device                         |
| --------------------------------- | --------- | ---------------------------------- |
| The deadline `holdSeconds`        | 0         | Safe                               |
| `SIGTERM` or `SIGINT`             | 0         | Safe                               |
| Another controller holds the lock | 0         | Not touched                        |
| An error, after `safe()` succeeds | 1         | Safe; run `finally.mjs` to confirm |
| An error, and `safe()` fails      | 1         | Unknown; run `finally.mjs`         |
| `SIGKILL`                         | None      | Unknown; run `finally.mjs`         |

**Exit 0 means safe.** It does not mean that the target was reached. The
event log states the claim, and you confirm it with a sensor.

## The event log

The controller appends JSON lines to `events.jsonl` in the checkout.
`ACTUATOR_EVENTS` names another file. Read the log with `read` or `bash`.

| Line      | When                                                  |
| --------- | ----------------------------------------------------- |
| `target`  | At the start, with the tolerance and the log interval |
| `observe` | At each log interval: the measured value              |
| `drive`   | At each log interval: the output                      |
| `state`   | At each change of claim                               |

**The claims follow the loop.** `acting` comes first. `reached` comes
when the value stays inside the tolerance for `settleSeconds`, and
`holding` follows it. `stopping` and `safe` come at a stop. `gave_up`
comes when the lock is busy.

**The log is a claim.** Confirm `reached` and `holding` through a sensor
of the workspace, and cite its snapshot.
