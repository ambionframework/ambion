/**
 * A simulated first-order plant, such as a water bath with a heater.
 *
 * The value moves toward `ambient + gain * output * tau` with the time
 * constant `tau`, in seconds. The state lives in the file `sim.state`, so
 * `finally.mjs` in another process reaches the same plant. `sim.failAfterReads`
 * makes `read()` fail, to test the path of an error.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export function openPlant(config) {
	const { ambient, tau, gain, state: path, failAfterReads } = config.sim;
	let reads = 0;
	const load = () => {
		try {
			return JSON.parse(readFileSync(path, 'utf8'));
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
			return { value: ambient, output: config.output.safe, at: Date.now() };
		}
	};
	const save = (state) => {
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(state));
		renameSync(temporary, path);
	};
	const advance = () => {
		const state = load();
		const now = Date.now();
		const steady = ambient + gain * state.output * tau;
		const value = steady + (state.value - steady) * Math.exp(-(now - state.at) / 1000 / tau);
		return { value, output: state.output, at: now };
	};
	return {
		async read() {
			reads += 1;
			if (failAfterReads !== undefined && reads > failAfterReads) {
				throw new Error('The simulated instrument failed.');
			}
			const state = advance();
			save(state);
			return state.value;
		},
		async drive(output) {
			save({ ...advance(), output });
		},
		async safe() {
			save({ ...advance(), output: config.output.safe });
		},
	};
}
