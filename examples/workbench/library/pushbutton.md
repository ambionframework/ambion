# Momentary push button (summary)

**A momentary push button connects its pins only while a person presses it.**
It needs a pull resistor so the input pin reads a defined level when the
button is open.

## Wiring

- Use the internal pull-up: set the pin to `INPUT_PULLUP`. The pin reads
  high when open and low when pressed. Wire the button between the pin and
  ground.
- Or use an external pull-down of 10 kohms from the pin to ground, with the
  button between the pin and 5 V. The pin reads low when open and high when
  pressed.

## Bounce

The contacts bounce for a few milliseconds. Debounce in firmware: accept a
new state only after it holds for about 20 ms.

## Current

The pull resistor sets the current. A 10 kohm pull-up on 5 V draws
`5 / 10000 = 0.5 mA` while the button is pressed.
