# Firmware sketch

A starting point for the kit's firmware on an Arduino Uno R3: one LED and
one HC-SR04 distance unit.

1. Set each pin in `pins.md`. Cite the datasheet in `/library` for each
   limit.
2. Copy the same pins into the constants at the top of
   `sketch/sketch.ino`.
3. Commit, and push your branch. A push keeps the work.
4. Sweep the series resistor of the LED with `bash sweep/sweep.sh`. The
   sweep takes about 30 seconds and writes `sweep/results.csv`. Start it
   with a `name`, such as `sweep`. `bash` then returns while the sweep
   runs. Read its state later with `status` and its handle.
