/** A real retained sensor observation reaches Pi through its normal agent-tool adapter. */
import { defineAgent, startRoom } from '@ambionframework/ambion';
import { expect, it, onTestFinished } from 'vitest';
import { andrei, roomName, waitForRoom } from '../../ambion/test/support/room.ts';
import { callTool, quiet, scripted } from '../../ambion/test/support/scripted.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { frameBytes } from '../../workspace/test/support/sensor-blobs.ts';
import { openSensorObserveRoom } from '../../workspace/test/support/sensor-observe-room.ts';
import { pi, piExecution } from '../src/index.ts';

it.each([
	{ label: 'image mode', images: true },
	{ label: 'text-only mode', images: false },
])('passes actual observe content to the Pi provider in $label', async ({ images }) => {
	const sensor = await openSensorObserveRoom({ images });
	onTestFinished(() => sensor.close());
	const providerToolResults: { content: unknown[] }[] = [];
	const worker = defineAgent({
		name: 'observer',
		identity: 'Reads the connected bench sensor.',
		executor: pi({
			model: 'scripted/observer',
			instructions: 'Observe the bench once.',
			bundles: [sensor.workspace.tools({ images })],
		}),
	});
	const room = stopAtEnd(
		await startRoom({
			name: roomName('sensor-observe-pi'),
			agents: [worker],
			execution: piExecution({
				sessions: 'memory',
				stream: scripted((context, _agent, call) => {
					if (call === 1) return callTool('observe', { sensor: 'bench-one/bench' });
					for (const message of context.messages)
						if (message.role === 'toolResult') providerToolResults.push(message);
					return quiet();
				}),
			}),
		}),
	);
	try {
		const visit = await room.visit(andrei);
		await visit.send({ text: 'Read the connected sensor.' });
		await waitForRoom(room);

		const content = providerToolResults.at(-1)?.content;
		expect(content).toBeDefined();
		const imageParts = content?.filter(
			(part): part is { type: 'image'; data: string; mimeType: string } =>
				typeof part === 'object' && part !== null && 'type' in part && part.type === 'image',
		);
		if (images) {
			expect(imageParts).toHaveLength(1);
			expect(imageParts?.[0]).toMatchObject({ mimeType: 'image/png' });
			expect(Buffer.from(imageParts?.[0]?.data ?? '', 'base64')).toEqual(Buffer.from(frameBytes));
		} else {
			expect(imageParts).toHaveLength(0);
		}
		const text = content
			?.filter(
				(part): part is { type: 'text'; text: string } =>
					typeof part === 'object' && part !== null && 'type' in part && part.type === 'text',
			)
			.map((part) => part.text)
			.join('\n');
		expect(text).toContain('Sensor data: Supply stable at 5 V.');
		expect(text).toContain('Snapshot ref: ambion://workspace/');
		if (!images) expect(text).toContain('Frame at 2026-09-29T10:00:01.000Z:');
	} finally {
		await room.stop();
		await sensor.close();
	}
});
