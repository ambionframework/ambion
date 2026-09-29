import { describe, expect, it, onTestFinished } from 'vitest';
import { sensorConformance } from '../src/conformance.ts';
import { sensorFixture, unsupportedSpanFixture } from './support/sensor-fixture.ts';
import { httpSensorHarness } from './support/sensor-harness.ts';
import { type SensorDefect, startSensorServer } from './support/sensor-server.ts';

describe('sensorConformance against real HTTP replies', () => {
	it('passes a server with all four part types and fixed-span support', async () => {
		const server = await startSensorServer();
		onTestFinished(() => server.close());
		const harness = httpSensorHarness('sensor HTTP fixture', server.origin);
		for (const testCase of sensorConformance(harness, sensorFixture)) {
			await testCase.run();
		}
	});

	it.each([
		[
			'version',
			sensorFixture,
			'GET / returns the expected sensor names and span capabilities',
			'invalid sensor index',
		],
		[
			'observation-version',
			sensorFixture,
			'/bench/observe returns the expected latest observations',
			'invalid latest response',
		],
		[
			'digest',
			sensorFixture,
			'GET /files verifies every expected digest',
			'returned bytes with digest',
		],
		[
			'span',
			sensorFixture,
			'/bench/observe honors the declared span capability',
			'outside the requested span',
		],
		[
			'sample',
			sensorFixture,
			'/bench/observe honors the declared span capability',
			'Series sample',
		],
		[
			'name',
			sensorFixture,
			'GET / returns the expected sensor names and span capabilities',
			'declared sensor names',
		],
		[
			'unsupported-span',
			unsupportedSpanFixture,
			'/bench/observe honors the declared span capability',
			'expected 422',
		],
	] as const)(
		'rejects a server with a deliberate %s defect',
		async (defect, fixture, caseName, expectedMessage) => {
			const server = await startSensorServer(defect as SensorDefect);
			onTestFinished(() => server.close());
			const harness = httpSensorHarness(`sensor fixture with ${defect} defect`, server.origin);
			const testCase = sensorConformance(harness, fixture).find(
				(candidate) => candidate.name === caseName,
			);
			expect(testCase, `No conformance case matched ${String(caseName)}.`).toBeDefined();
			await expect(testCase?.run()).rejects.toThrow(expectedMessage);
		},
	);
});
