/**
 * The configuration of the controller. `ACTUATOR_CONFIG` names the file, and
 * the default is `config.json` in the working directory. `node config.mjs
 * <key>` prints one top-level value, for the start script.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NUMBERS = [
	'target',
	'tolerance',
	'settleSeconds',
	'holdSeconds',
	'periodMs',
	'logIntervalMs',
];

/** Read and check the configuration. A missing or wrong field stops the controller before it acts. */
export function loadConfig() {
	const path = resolve(process.env.ACTUATOR_CONFIG ?? 'config.json');
	const config = JSON.parse(readFileSync(path, 'utf8'));
	const wrong = NUMBERS.filter((key) => !Number.isFinite(config[key]));
	if (wrong.length > 0)
		throw new Error(`${path}: these fields must be numbers: ${wrong.join(', ')}.`);
	if (!/^[a-z][a-z0-9-]*$/.test(config.name ?? '')) throw new Error(`${path}: name is not valid.`);
	if (config.output === undefined || config.law === undefined) {
		throw new Error(`${path}: output and law are required.`);
	}
	return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	console.log(loadConfig()[process.argv[2] ?? 'name']);
}
