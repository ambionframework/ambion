# HC-SR04 ultrasonic distance unit (summary)

**The HC-SR04 measures distance by timing an ultrasonic echo.** It runs on
5 V and reports the distance as the width of one pulse.

## Electrical

| Parameter         | Value       |
| ----------------- | ----------- |
| Supply voltage    | 5 V         |
| Quiescent current | about 2 mA  |
| Working current   | about 15 mA |
| Logic level       | 5 V         |

## Interface

- `Trig`: the host holds this pin high for 10 microseconds to start a ping.
- `Echo`: the unit holds this pin high for the round-trip time of the sound.

## Range and timing

- Range: 2 cm to 400 cm.
- Distance in centimeters: `echo_microseconds / 58`.
- Wait at least 60 ms between pings, so one echo does not reach the next
  measurement.

## Notes

The Echo pin drives 5 V. A 5 V board like the Uno reads it directly. A 3.3 V
board needs a divider.
