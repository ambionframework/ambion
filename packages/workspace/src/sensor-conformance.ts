/** The cases every sensor server must pass. The probe fixture supplies raw replies. */
import { isDeepStrictEqual } from 'node:util';
import {
	type ConformanceCase,
	type ConformanceFixture,
	check,
	conformanceSuite,
} from '@ambionframework/ambion/conformance';
import { Check } from 'typebox/value';
import { sha256Hex } from './object-rules.ts';
import {
	isValidObserveRequest,
	ObserveResponseSchema,
	SensorErrorSchema,
	SensorIndexSchema,
	type SensorObservation,
	type SensorSpan,
} from './sensor-api.ts';

/** A raw reply from one server request. JSON replies use `body`; file replies use `bytes`. */
export interface SensorConformanceReply {
	readonly status: number;
	readonly contentType: string | null;
	readonly body?: unknown;
	readonly bytes?: Uint8Array;
}

/** The raw request surface needed by the conformance cases. */
export interface SensorConformanceProbe {
	request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<SensorConformanceReply>;
	dispose(): Promise<void>;
}

/** Expected wire evidence supplied independently from the server under test. */
export interface SensorConformanceFixture {
	readonly span: SensorSpan;
	readonly sensors: readonly {
		readonly name: string;
		readonly spans: boolean;
		readonly latest: readonly SensorObservation[];
		readonly withinSpan: readonly SensorObservation[];
	}[];
	readonly files: readonly { readonly digest: string; readonly bytes: Uint8Array }[];
}

type Body = (probe: SensorConformanceProbe) => Promise<void>;

function checkJson(reply: SensorConformanceReply, status: number, what: string): unknown {
	check(reply.status === status, `${what} returned HTTP ${reply.status}; expected ${status}.`);
	check(
		reply.contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json',
		`${what} did not return a JSON content type.`,
	);
	return reply.body;
}

function fixtureFor(fixture: SensorConformanceFixture, name: string) {
	const sensor = fixture.sensors.find((candidate) => candidate.name === name);
	if (!sensor) throw new Error(`The conformance fixture has no sensor named ${name}.`);
	return sensor;
}

function checkObservationSpan(observations: readonly SensorObservation[], span: SensorSpan): void {
	const start = Date.parse(span.from);
	const end = Date.parse(span.to);
	for (const observation of observations) {
		checkTimestampSpan(Date.parse(observation.at), start, end, `Observation ${observation.at}`);
		for (const part of observation.parts) {
			if (part.kind === 'series') checkSeriesSpan(part, start, end);
		}
	}
}

function checkSeriesSpan(
	part: Extract<SensorObservation['parts'][number], { kind: 'series' }>,
	start: number,
	end: number,
): void {
	const first = Date.parse(part.from);
	for (let index = 0; index < part.values.length; index++) {
		const sampleAt = first + index * part.intervalMs;
		checkTimestampSpan(
			sampleAt,
			start,
			end,
			`Series sample ${index} at ${new Date(sampleAt).toISOString()}`,
		);
	}
}

function checkTimestampSpan(at: number, start: number, end: number, label: string): void {
	check(at >= start && at < end, `${label} is outside the requested span.`);
}

async function indexCase(probe: SensorConformanceProbe, fixture: SensorConformanceFixture) {
	const index = checkJson(await probe.request('GET', '/'), 200, 'GET /');
	check(Check(SensorIndexSchema, index), 'GET / returned an invalid sensor index.');
	if (!Check(SensorIndexSchema, index)) return;
	const names = fixture.sensors.map(({ name }) => name).sort();
	const actual = index.sensors.map(({ name }) => name).sort();
	check(
		JSON.stringify(actual) === JSON.stringify(names),
		`GET / declared sensor names ${actual.join(', ')}; expected ${names.join(', ')}.`,
	);
	for (const expected of fixture.sensors) {
		const found = index.sensors.find((sensor) => sensor.name === expected.name);
		check(
			found?.spans === expected.spans,
			`Sensor ${expected.name} declared the wrong spans capability.`,
		);
	}
}

async function latestCase(
	probe: SensorConformanceProbe,
	fixture: SensorConformanceFixture,
	name: string,
) {
	const result = checkJson(
		await probe.request('POST', `/${name}/observe`, { api: 1 }),
		200,
		`observe ${name} latest`,
	);
	check(
		Check(ObserveResponseSchema, result),
		`Sensor ${name} returned an invalid latest response.`,
	);
	if (!Check(ObserveResponseSchema, result)) return;
	const expected = fixtureFor(fixture, name).latest;
	check(
		isDeepStrictEqual(result.observations, expected),
		`Sensor ${name} returned unexpected latest observations.`,
	);
}

async function spanCase(
	probe: SensorConformanceProbe,
	fixture: SensorConformanceFixture,
	name: string,
) {
	const sensor = fixtureFor(fixture, name);
	const result = await probe.request('POST', `/${name}/observe`, { api: 1, span: fixture.span });
	if (!sensor.spans) {
		const error = checkJson(result, 422, `observe ${name} with span`);
		check(Check(SensorErrorSchema, error), `Sensor ${name} returned an invalid span error.`);
		if (Check(SensorErrorSchema, error)) {
			check(
				error.api === 1 && error.code === 'unavailable',
				`Sensor ${name} returned the wrong span error.`,
			);
		}
		return;
	}
	const body = checkJson(result, 200, `observe ${name} with span`);
	check(Check(ObserveResponseSchema, body), `Sensor ${name} returned an invalid span response.`);
	if (!Check(ObserveResponseSchema, body)) return;
	checkObservationSpan(body.observations, fixture.span);
	check(
		isDeepStrictEqual(body.observations, sensor.withinSpan),
		`Sensor ${name} returned unexpected span observations.`,
	);
}

async function requestErrorsCase(
	probe: SensorConformanceProbe,
	fixture: SensorConformanceFixture,
	name: string,
) {
	const cases = [
		{
			method: 'POST' as const,
			path: `/${name}/observe`,
			body: { api: 2 },
			status: 400,
			code: 'invalid',
			name: 'wrong-version observe request',
		},
		{
			method: 'POST' as const,
			path: `/${unknownSensorName(fixture)}/observe`,
			body: { api: 1 },
			status: 404,
			code: 'unknown',
			name: 'unknown sensor request',
		},
		{
			method: 'POST' as const,
			path: `/${name}/observe`,
			body: { api: 1, span: { from: fixture.span.to, to: fixture.span.from } },
			status: 400,
			code: 'invalid',
			name: 'reversed span request',
		},
		{
			method: 'POST' as const,
			path: `/${name}/observe`,
			body: { api: 1, span: { from: fixture.span.from, to: fixture.span.from } },
			status: 400,
			code: 'invalid',
			name: 'empty span request',
		},
		{
			method: 'GET' as const,
			path: `/files/${missingFileDigest(fixture)}`,
			status: 404,
			code: 'unknown',
			name: 'unknown file request',
		},
		{
			method: 'GET' as const,
			path: '/unknown-path',
			status: 404,
			code: 'unknown',
			name: 'unknown path request',
		},
	];
	for (const testCase of cases) {
		const reply = await probe.request(testCase.method, testCase.path, testCase.body);
		checkErrorReply(reply, testCase.status, testCase.code, testCase.name);
	}
}

function checkErrorReply(
	reply: SensorConformanceReply,
	status: number,
	code: string,
	name: string,
): void {
	const error = checkJson(reply, status, name);
	check(Check(SensorErrorSchema, error), `${name} returned an invalid error envelope.`);
	if (Check(SensorErrorSchema, error)) {
		check(error.api === 1 && error.code === code, `${name} returned the wrong error.`);
	}
}

function unknownSensorName(fixture: SensorConformanceFixture): string {
	let name = 'unknown-sensor';
	while (fixture.sensors.some((sensor) => sensor.name === name)) name = `x-${name}`;
	return name;
}

function missingFileDigest(fixture: SensorConformanceFixture): string {
	let index = 0;
	let digest = index.toString(16).padStart(64, '0');
	while (fixture.files.some((file) => file.digest === digest)) {
		index++;
		digest = index.toString(16).padStart(64, '0');
	}
	return digest;
}

function referencedFileTypes(fixture: SensorConformanceFixture): Map<string, Set<string>> {
	const referenced = new Map<string, Set<string>>();
	const observations = fixture.sensors.flatMap((sensor) => [
		...sensor.latest,
		...sensor.withinSpan,
	]);
	for (const observation of observations) {
		for (const part of observation.parts) {
			if (part.kind === 'frame' || part.kind === 'file')
				addReferencedFile(referenced, part.file, part.mediaType);
		}
	}
	return referenced;
}

function addReferencedFile(
	referenced: Map<string, Set<string>>,
	digest: string,
	mediaType: string,
): void {
	const mediaTypes = referenced.get(digest) ?? new Set<string>();
	mediaTypes.add(mediaType);
	referenced.set(digest, mediaTypes);
}

async function filesCase(probe: SensorConformanceProbe, fixture: SensorConformanceFixture) {
	const referenced = referencedFileTypes(fixture);
	for (const file of fixture.files) {
		const reply = await probe.request('GET', `/files/${file.digest}`);
		check(reply.status === 200, `File ${file.digest} returned HTTP ${reply.status}; expected 200.`);
		check(reply.bytes !== undefined, `File ${file.digest} did not return bytes.`);
		for (const expectedMediaType of referenced.get(file.digest) ?? []) {
			check(
				reply.contentType?.split(';', 1)[0]?.toLowerCase() === expectedMediaType.toLowerCase(),
				`File ${file.digest} returned content type ${reply.contentType}; expected ${expectedMediaType}.`,
			);
		}
		if (!reply.bytes) continue;
		const digest = sha256Hex(reply.bytes);
		check(digest === file.digest, `File ${file.digest} returned bytes with digest ${digest}.`);
		check(
			Buffer.from(reply.bytes).equals(Buffer.from(file.bytes)),
			`File ${file.digest} returned bytes that differ from the fixture.`,
		);
	}
}

/**
 * Returns stable cases for the expected fixtures in `fixture`. Each case
 * opens one probe. Network and process details belong to the probe fixture.
 */
export function sensorConformance(
	probeFixture: ConformanceFixture<SensorConformanceProbe>,
	fixture: SensorConformanceFixture,
): readonly ConformanceCase[] {
	check(
		isValidObserveRequest({ api: 1, span: fixture.span }),
		'The conformance fixture must supply an increasing, valid fixed span.',
	);
	check(fixture.sensors.length > 0, 'The conformance fixture must declare at least one sensor.');
	const names = fixture.sensors.map(({ name }) => name);
	check(
		new Set(names).size === names.length,
		'The conformance fixture has duplicate sensor names.',
	);
	const fileDigests = fixture.files.map(({ digest }) => digest);
	check(
		new Set(fileDigests).size === fileDigests.length,
		'The conformance fixture has duplicate file digests.',
	);
	const expectedFiles = new Set(fileDigests);
	for (const digest of referencedFileTypes(fixture).keys()) {
		check(expectedFiles.has(digest), `The fixture has no bytes for referenced digest ${digest}.`);
	}
	const cases: [string, Body][] = [
		[
			'GET / returns the expected sensor names and span capabilities',
			(probe) => indexCase(probe, fixture),
		],
	];
	for (const sensor of fixture.sensors) {
		cases.push([
			`/${sensor.name}/observe returns the expected latest observations`,
			(probe) => latestCase(probe, fixture, sensor.name),
		]);
		cases.push([
			`/${sensor.name}/observe honors the declared span capability`,
			(probe) => spanCase(probe, fixture, sensor.name),
		]);
	}
	const first = fixture.sensors[0];
	if (first) {
		cases.push([
			'Observe rejects a wrong version and an unknown sensor',
			(probe) => requestErrorsCase(probe, fixture, first.name),
		]);
	}
	cases.push(['GET /files verifies every expected digest', (probe) => filesCase(probe, fixture)]);
	return conformanceSuite(probeFixture, cases);
}
