/**
 * The controller harness. Keep this file, and customize `device.mjs`,
 * `law.mjs`, and `config.json`.
 *
 * The harness holds the controller contract:
 * - It installs the stop handlers before it opens or drives the device.
 * - SIGTERM and SIGINT make the device safe, and the process exits 0.
 * - The deadline `holdSeconds` makes the device safe, and the process exits 0.
 * - An error makes the device safe if it can, and the process exits 1, so
 *   the workspace runs `finally`.
 * - One queue serializes every call to the device, so `safe()` comes after
 *   an output that was already on its way.
 * - It logs the target, the measured value, the output, and its claims.
 */

import { loadConfig } from './config.mjs';
import { openDevice } from './device.mjs';
import { emit } from './events.mjs';
import { createLaw } from './law.mjs';

let device;
let stopping = false;
let timer;
let queue = Promise.resolve();

/** Run `work` after every earlier call to the device. */
function serial(work) {
	queue = queue.then(work, work);
	return queue;
}

/** Make the device safe once, log it, and exit with `code`. */
async function stop(reason, code) {
	if (stopping) return;
	stopping = true;
	clearTimeout(timer);
	if (reason !== 'deadline') emit('state', { value: 'stopping', note: reason });
	try {
		if (device !== undefined) await serial(() => device.safe());
		emit('state', { value: 'safe', note: reason });
		process.exit(code);
	} catch (error) {
		console.error(`The device did not reach its safe state: ${error.message}`);
		process.exit(1);
	}
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(signal, 0));
for (const event of ['uncaughtException', 'unhandledRejection']) {
	process.on(event, (error) => {
		console.error(error);
		stop(`error: ${error?.message ?? error}`, 1);
	});
}

const config = loadConfig();
device = await openDevice(config);
const law = createLaw(config);
const deadline = Date.now() + config.holdSeconds * 1000;
const claims = { current: 'acting', inBandSince: undefined, loggedAt: 0 };

/** Log a claim when it changes. */
function claim(value, note) {
	if (claims.current === value) return;
	claims.current = value;
	emit('state', note === undefined ? { value } : { value, note });
}

/** Update the claim from one measured value. */
function judge(value, now) {
	if (Math.abs(value - config.target) > config.tolerance) {
		claims.inBandSince = undefined;
		if (claims.current === 'holding') claim('acting', 'the value left the tolerance');
		return;
	}
	claims.inBandSince ??= now;
	if (claims.current !== 'acting' || now - claims.inBandSince < config.settleSeconds * 1000) return;
	claim('reached', `within ${config.tolerance} ${config.unit} for ${config.settleSeconds} s`);
	claim('holding');
}

/** Log the measured value and the output at the log interval. */
function record(value, output, now) {
	if (now - claims.loggedAt < config.logIntervalMs) return;
	claims.loggedAt = now;
	const round = (number) => Math.round(number * 1000) / 1000;
	emit('observe', { name: config.name, value: round(value), unit: config.unit });
	emit('drive', { name: config.output.name, value: round(output), unit: config.output.unit });
}

/** One period of the loop: read, decide, drive, log. */
async function tick() {
	if (stopping) return;
	if (Date.now() >= deadline) return stop('deadline', 0);
	const value = await serial(() => device.read());
	if (stopping) return;
	const output = law.next(value, config.periodMs / 1000);
	await serial(() => device.drive(output));
	const now = Date.now();
	judge(value, now);
	record(value, output, now);
	if (!stopping) timer = setTimeout(tick, config.periodMs);
}

emit('target', {
	name: config.name,
	value: config.target,
	unit: config.unit,
	tolerance: config.tolerance,
	interval: config.logIntervalMs / 1000,
});
emit('state', { value: 'acting', note: `device ${config.device}` });
tick();
