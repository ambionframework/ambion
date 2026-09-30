/** The captured sensor discovery shown at the start of an activation. */

import type { ReminderSeat } from '@ambionframework/ambion';
import type { ProcessTable } from './process-table.ts';
import type { SensorConnections, SensorDiscovery } from './sensor-connections.ts';

/** Render connection facts and qualified sensor names without transport data. */
function sensorReminderText(discoveries: readonly SensorDiscovery[]): string | undefined {
	if (discoveries.length === 0) return undefined;
	const lines = ['Connected sensor servers in the workspace:'];
	for (const connection of discoveries) {
		lines.push(
			`- ${connection.name} on ${connection.hostname}, process ${connection.process}, remote port ${connection.port}: ${stateText(connection.state)}`,
		);
		for (const sensor of connection.sensors)
			lines.push(`  - ${connection.name}/${sensor.name}: ${sensor.description}`);
	}
	return lines.join('\n');
}

/** Compose process and sensor reminders while bounding sensor status reads. */
export async function workspaceReminder(
	seat: ReminderSeat,
	signal: AbortSignal,
	processes: ProcessTable,
	connections: SensorConnections | undefined,
): Promise<string | undefined> {
	const processReminder = processes.remind(seat, signal).catch(() => undefined);
	const sensorReminder =
		connections === undefined
			? Promise.resolve(undefined)
			: boundedSensorReminder(connections, signal);
	const [processText, sensorText] = await Promise.all([processReminder, sensorReminder]);
	return (
		[processText, sensorText]
			.filter((text): text is string => text !== undefined && text.trim() !== '')
			.join('\n\n') || undefined
	);
}

const SENSOR_REMINDER_TIMEOUT_MS = 750;

async function boundedSensorReminder(
	connections: SensorConnections,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (signal.aborted) return undefined;
	const controller = new AbortController();
	const combined = AbortSignal.any([signal, controller.signal]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			controller.abort(new Error('Sensor reminder status check timed out.'));
			resolve(undefined);
		}, SENSOR_REMINDER_TIMEOUT_MS);
	});
	try {
		return await Promise.race([
			connections
				.list(combined)
				.then(sensorReminderText)
				.catch(() => undefined),
			timeout,
		]);
	} finally {
		clearTimeout(timer);
	}
}

function stateText(state: SensorDiscovery['state']): string {
	if (state === 'connected') return 'connected';
	if (state === 'unavailable') return 'unavailable';
	if (state === 'disconnected') return 'disconnected';
	return 'process status unknown';
}
