/**
 * The backstop after an unclean end: a kill, a crash, or an exit code other
 * than 0. It makes the device safe. It needs no state from the controller,
 * and a second run changes nothing.
 */

import { loadConfig } from './config.mjs';
import { openDevice } from './device.mjs';
import { emit } from './events.mjs';

const config = loadConfig();
const device = await openDevice(config);
await device.safe();
emit('state', { value: 'safe', note: 'finally' });
console.log(`${config.name}: safe`);
