import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SensorApiSchema } from '../dist/sensors.mjs';

const output = join(dirname(fileURLToPath(import.meta.url)), '../dist/sensor-api.schema.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(SensorApiSchema, null, '\t')}\n`);
