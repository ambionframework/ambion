import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { ObserveResponse, SensorIndex } from '@ambionframework/workspace/sensors';
import { demoFrame } from './frame.ts';
import { openSensor } from './server.ts';

test('serves discovery, latest observations, and immutable PNG bytes', async () => {
	const source = { repository: 'observer/camera', commit: 'a'.repeat(40), dirty: false };
	const sensor = await openSensor(source);
	try {
		const root = `http://127.0.0.1:${sensor.port}`;
		const frame = demoFrame();
		sensor.receive(frame);
		const index = (await (await fetch(root)).json()) as SensorIndex;
		assert.deepEqual(index.source, source);
		const observation = (await (
			await fetch(`${root}/camera/observe`, { method: 'POST', body: JSON.stringify({ api: 1 }) })
		).json()) as ObserveResponse;
		assert.equal(
			observation.observations[0]?.parts[0] && 'file' in observation.observations[0].parts[0]
				? observation.observations[0].parts[0].file
				: undefined,
			frame.digest,
		);
		const bytes = Buffer.from(await (await fetch(`${root}/files/${frame.digest}`)).arrayBuffer());
		assert.equal(createHash('sha256').update(bytes).digest('hex'), frame.digest);
		assert.ok(bytes.equals(frame.png));
	} finally {
		await sensor.close();
	}
});
