/** A retained sensor observation reaches the Claude SDK through its real MCP tool adapter. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineAgent, startRoom } from '@ambionframework/ambion';
import { expect, it, onTestFinished } from 'vitest';
import { andrei, roomName, waitForRoom } from '../../ambion/test/support/room.ts';
import { stopAtEnd } from '../../ambion/test/support/stop.ts';
import { openSensorObserveRoom } from '../../workspace/test/support/sensor-observe-room.ts';
import { frameBytes } from '../../workspace/test/support/sensor-blobs.ts';
import { claude, claudeExecution } from '../src/index.ts';
import { executable } from './support.ts';

it('passes actual observe image content to the Claude SDK', async () => {
	const sensor = await openSensorObserveRoom({ images: true });
	onTestFinished(() => sensor.close());
	const logDir = mkdtempSync(join(tmpdir(), 'ambion-claude-observe-'));
	const logFile = join(logDir, 'fake.log');
	onTestFinished(() => rmSync(logDir, { recursive: true, force: true }));
	const worker = defineAgent({
		name: 'observer',
		identity: 'Reads the connected bench sensor.',
		executor: claude({
			model: 'claude-fake',
			instructions: 'Observe the bench once.',
			bundles: [sensor.workspace.tools({ images: true })],
		}),
	});
	const room = stopAtEnd(
		await startRoom({
			name: roomName('sensor-observe-claude'),
			agents: [worker],
			execution: claudeExecution({
				pathToClaudeCodeExecutable: executable,
				env: {
					...process.env,
					AMBION_FAKE: JSON.stringify({
						turns: [[{ call: { tool: 'observe', args: { sensor: 'bench-one/bench' } } }]],
						log: logFile,
					}),
				},
			}),
		}),
	);
	try {
		const visit = await room.visit(andrei);
		await visit.send({ text: 'Read the connected sensor.' });
		await waitForRoom(room);

		const entries = readFileSync(logFile, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const invocation = entries.find(
			(entry) =>
				'tool_result' in entry && (entry.tool_result as { tool?: string }).tool === 'observe',
		)?.tool_result as { content: unknown[] } | undefined;
		const content = invocation?.content;
		expect(content).toBeDefined();
		const imageParts = content?.filter(
			(part): part is { type: 'image'; data: string; mimeType: string } =>
				typeof part === 'object' && part !== null && 'type' in part && part.type === 'image',
		);
		expect(imageParts).toHaveLength(1);
		expect(imageParts?.[0]).toMatchObject({ mimeType: 'image/png' });
		expect(Buffer.from(imageParts?.[0]?.data ?? '', 'base64')).toEqual(Buffer.from(frameBytes));
		const text = content
			?.filter(
				(part): part is { type: 'text'; text: string } =>
					typeof part === 'object' && part !== null && 'type' in part && part.type === 'text',
			)
			.map((part) => part.text)
			.join('\n');
		expect(text).toContain('Sensor data: Supply stable at 5 V.');
		expect(text).toContain('Snapshot ref: ambion://workspace/');
	} finally {
		await room.stop();
		await sensor.close();
		rmSync(logDir, { recursive: true, force: true });
	}
});
