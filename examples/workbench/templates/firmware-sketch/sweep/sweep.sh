# Sweep the series resistor of the red LED on a 5 V pin.
#
# The kit has no hardware, so each step computes the planned current from
# /library/led-5mm.md: I = (Vsupply - Vf) / R, with Vf = 2.0 V. Each step
# waits the way a bench measurement does. The sweep writes one row for each
# resistor to sweep/results.csv, and one progress line to its output.
#
# Run it from the root of the clone: bash sweep/sweep.sh [seconds per step]
# The default step is 3 seconds, so the sweep takes about 30 seconds.

step="${1:-3}"
results=sweep/results.csv
rows=0
echo 'resistor_ohm,current_ma' > "$results"
for ohm in 150 180 220 270 330 390 470 560 680 1000; do
	sleep "$step"
	microamp=$(( (5000 - 2000) * 1000 / ohm ))
	current="$(( microamp / 1000 )).$(printf '%03d' $(( microamp % 1000 )))"
	echo "$ohm,$current" >> "$results"
	rows=$(( rows + 1 ))
	echo "step $rows: $ohm ohm, $current mA"
done
echo "sweep done: $rows rows in $results"
