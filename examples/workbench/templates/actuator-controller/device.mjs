/**
 * The device. Customize this file to reach the real actuator and its
 * instrument.
 *
 * A device gives three functions:
 * - `read()` gives the measured value of the stock, in `config.unit`.
 * - `drive(output)` sets the output, in `config.output.unit`.
 * - `safe()` sets the safe output. It must be idempotent, and it must need no
 *   state from an earlier process, because `finally.mjs` calls it alone.
 */

import { openPlant } from './plant.mjs';

/** Open the device that `config.device` names. */
export async function openDevice(config) {
	if (config.device === 'sim') return openPlant(config);
	if (config.device === 'hardware') return openHardware(config);
	throw new Error(`Unknown device "${config.device}". Use "sim" or "hardware".`);
}

/** Replace this function with the driver of the real device. */
async function openHardware(_config) {
	throw new Error('Write the driver in device.mjs: read(), drive(output), and safe().');
}
