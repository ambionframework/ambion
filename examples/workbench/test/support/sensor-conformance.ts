import type { SensorConformanceHarness } from '@ambionframework/workspace/conformance';
import {
	type SensorConformanceFixture,
	sensorConformance,
} from '@ambionframework/workspace/conformance';

const span = { from: '2025-01-02T03:04:00.000Z', to: '2025-01-02T03:05:00.000Z' } as const;

export function templateSensorFixture(
	frameDigest: string,
	frameBytes: Uint8Array,
	roomTemperature: readonly number[],
): SensorConformanceFixture {
	return {
		span,
		sensors: [
			{
				name: 'room-temperature',
				spans: false,
				latest: [
					{
						at: '2025-01-02T03:04:05.000Z',
						parts: [
							{
								kind: 'series',
								channel: 'temperature',
								unit: 'degC',
								from: '2025-01-02T03:04:05.000Z',
								intervalMs: 1000,
								values: [...roomTemperature],
							},
						],
					},
				],
				withinSpan: [],
			},
			{
				name: 'bench-camera',
				spans: false,
				latest: [
					{
						at: '2025-01-02T03:04:06.000Z',
						parts: [{ kind: 'frame', file: frameDigest, mediaType: 'image/png' }],
					},
				],
				withinSpan: [],
			},
			{
				name: 'operator-notes',
				spans: false,
				latest: [
					{
						at: '2025-01-02T03:04:07.000Z',
						parts: [{ kind: 'text', text: 'Fixture run: the indicator is green.' }],
					},
				],
				withinSpan: [],
			},
		],
		files: [{ digest: frameDigest, bytes: frameBytes }],
	};
}

export function templateSensorHarness(origin: string): SensorConformanceHarness {
	return {
		name: 'landed sensor-server template',
		async open() {
			return {
				async request(method, path, body) {
					const response = await fetch(`${origin}${path}`, {
						method,
						...(body === undefined
							? {}
							: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
					});
					const contentType = response.headers.get('content-type');
					if (contentType?.includes('application/json')) {
						return { status: response.status, contentType, body: await response.json() };
					}
					return {
						status: response.status,
						contentType,
						bytes: new Uint8Array(await response.arrayBuffer()),
					};
				},
				async dispose() {},
			};
		},
	};
}

export async function runTemplateSensorConformance(
	origin: string,
	fixture: SensorConformanceFixture,
): Promise<void> {
	for (const testCase of sensorConformance(templateSensorHarness(origin), fixture))
		await testCase.run();
}
