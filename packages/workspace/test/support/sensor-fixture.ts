import type { SensorConformanceFixture } from '../../src/conformance.ts';
import { fileBytes, fileDigest, frameBytes, frameDigest } from './sensor-blobs.ts';

const span = { from: '2026-09-29T10:00:00.000Z', to: '2026-09-29T10:00:03.000Z' } as const;

export const sensorFixture: SensorConformanceFixture = {
	span,
	sensors: [
		{
			name: 'bench',
			spans: true,
			latest: [
				{
					at: '2026-09-29T09:59:59.000Z',
					parts: [
						{
							kind: 'series',
							channel: 'voltage',
							unit: 'V',
							from: '2026-09-29T09:59:58.000Z',
							intervalMs: 1000,
							values: [4.98, 4.99],
						},
					],
				},
				{
					at: '2026-09-29T10:00:01.000Z',
					parts: [
						{
							kind: 'series',
							channel: 'voltage',
							unit: 'V',
							from: span.from,
							intervalMs: 1000,
							values: [5, 5.01, 5.02],
						},
						{ kind: 'text', text: 'Supply stable at 5 V.' },
						{ kind: 'frame', file: frameDigest, mediaType: 'image/png' },
						{ kind: 'file', file: fileDigest, name: 'reading.csv', mediaType: 'text/csv' },
					],
				},
			],
			withinSpan: [
				{
					at: '2026-09-29T10:00:01.000Z',
					parts: [
						{
							kind: 'series',
							channel: 'voltage',
							unit: 'V',
							from: span.from,
							intervalMs: 1000,
							values: [5, 5.01, 5.02],
						},
						{ kind: 'text', text: 'Supply stable at 5 V.' },
						{ kind: 'frame', file: frameDigest, mediaType: 'image/png' },
						{ kind: 'file', file: fileDigest, name: 'reading.csv', mediaType: 'text/csv' },
					],
				},
			],
		},
	],
	files: [
		{ digest: frameDigest, bytes: frameBytes },
		{ digest: fileDigest, bytes: fileBytes },
	],
};

export const unsupportedSpanFixture: SensorConformanceFixture = {
	...sensorFixture,
	sensors: sensorFixture.sensors.map((sensor) => ({ ...sensor, spans: false, withinSpan: [] })),
};
