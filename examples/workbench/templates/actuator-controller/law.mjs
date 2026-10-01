/**
 * The control law. Customize this file to change how the loop converges.
 *
 * The template uses a PI law with output limits. It adds to the integral only
 * while the output is inside its limits, so a long saturation does not wind
 * it up.
 */

/**
 * A law for one loop: `next(value, seconds)` gives the next output.
 * `seconds` is the time since the previous read, as the clock measured it.
 * A loop that runs late still integrates at the rate of the plant.
 */
export function createLaw(config) {
	const { kp, ki } = config.law;
	const { min, max } = config.output;
	let integral = 0;
	return {
		next(value, seconds) {
			const error = config.target - value;
			const candidate = integral + ki * error * seconds;
			const wanted = kp * error + candidate;
			const output = Math.min(max, Math.max(min, wanted));
			if (output === wanted) integral = candidate;
			return output;
		},
	};
}
