# 5 mm LED (summary)

**A 5 mm through-hole LED needs a series resistor on a 5 V pin.** The LED
sets its forward voltage; the resistor sets the current.

## Forward voltage by color

| Color  | Typical forward voltage (Vf) |
| ------ | ---------------------------- |
| Red    | 1.8 V to 2.2 V               |
| Yellow | 2.0 V to 2.4 V               |
| Green  | 2.0 V to 3.0 V               |
| Blue   | 3.0 V to 3.4 V               |
| White  | 3.0 V to 3.4 V               |

## Current

- Maximum continuous forward current: 20 mA.
- A comfortable, bright value: 10 mA.

## Series resistor

Use Ohm's law for the resistor value:

```
R = (Vsupply - Vf) / I
```

Example: a red LED (Vf = 2.0 V) at 10 mA on a 5 V pin needs
`R = (5 - 2.0) / 0.010 = 300 ohms`. Choose the next higher stock value.
