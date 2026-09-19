# Arduino Uno R3 (summary)

**The Uno R3 is a 5 V microcontroller board built on the ATmega328P.** Use
it for the bring-up examples in this kit.

## Electrical limits

| Parameter                    | Value                         |
| ---------------------------- | ----------------------------- |
| Logic level                  | 5 V                           |
| Recommended current per I/O  | 20 mA                         |
| Absolute maximum per I/O     | 40 mA                         |
| Sum of all I/O pins          | 200 mA                        |
| 5 V pin, on USB power        | about 400 mA, less board draw |
| 3.3 V pin                    | 50 mA                         |
| Input voltage on any I/O pin | 0 V to 5 V                    |

Do not draw the absolute maximum. Design to the recommended 20 mA per pin.

## Useful pins

- Pin 13 has the on-board LED. Use it for the first blink test.
- Pins 3, 5, 6, 9, 10, and 11 give PWM output.
- Pins A0 to A5 read analog voltage from 0 V to 5 V with 10-bit resolution.

## Notes

The example never connects a real board. Treat every measurement as a
planned value, not a reading.
