# Carbon-film resistors, E12 (summary)

**The kit uses 1/4 W carbon-film resistors from the E12 series.** Pick the
nearest stock value at or above the value the design needs.

## E12 series (each decade)

```
10  12  15  18  22  27  33  39  47  56  68  82
```

Multiply by 1, 10, 100, or 1000 for each decade. For example 220, 330, and
470 ohms are stock values.

## Color code (four bands)

| Band   | Meaning                    |
| ------ | -------------------------- |
| Band 1 | First digit                |
| Band 2 | Second digit               |
| Band 3 | Multiplier (powers of ten) |
| Band 4 | Tolerance (gold is 5%)     |

Example: red, red, brown, gold is `22 x 10 = 220 ohms`, 5%.

## Power

- Rating: 0.25 W.
- Check power with `P = I^2 x R`. At 10 mA through 330 ohms,
  `P = 0.010^2 x 330 = 0.033 W`, well under the rating.
