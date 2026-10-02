/** Pure validation and immutable metadata for registered sensor links. */
import type { Process } from './process-files.ts';
import type { WorkspaceAgent } from './resource.ts';
import type { SensorIndex, SensorSource } from './sensor-api.ts';
import type { RegisteredSensorConnection, SensorDiscovery } from './sensor-connections.ts';

export function sameIdentity(
	connection: RegisteredSensorConnection,
	agent: WorkspaceAgent,
	process: string,
	port: number,
): boolean {
	return (
		connection.owner === agent.name &&
		connection.process.handle === process &&
		connection.port === port
	);
}

export function validateIndex(index: SensorIndex): void {
	const names = new Set<string>();
	for (const sensor of index.sensors) {
		if (!/^[a-z][a-z0-9-]*(?![\s\S])/.test(sensor.name))
			throw new Error(`Invalid sensor name '${sensor.name}' in the server index.`);
		if (names.has(sensor.name))
			throw new Error(`Duplicate sensor name '${sensor.name}' in the server index.`);
		names.add(sensor.name);
	}
}

export function freezeSource(source: SensorSource): SensorSource {
	return Object.freeze({ ...source });
}

export function sameSource(a: SensorSource, b: SensorSource): boolean {
	return (
		a.repository === b.repository &&
		a.commit === b.commit &&
		a.branch === b.branch &&
		a.dirty === b.dirty
	);
}

export function freezeIndex(index: SensorIndex, source: SensorSource): SensorIndex {
	return Object.freeze({
		api: 1,
		source,
		sensors: Object.freeze(index.sensors.map((sensor) => Object.freeze({ ...sensor }))),
	});
}

export function discovery(
	connection: RegisteredSensorConnection,
	state: SensorDiscovery['state'],
): SensorDiscovery {
	return Object.freeze({
		name: connection.name,
		hostname: connection.hostname,
		port: connection.port,
		process: connection.process.handle,
		state,
		sensors: connection.index.sensors,
	});
}

export function belongsToEnded(connection: RegisteredSensorConnection, process: Process): boolean {
	return connection.process.handle === process.handle && connection.owner === process.agent;
}
