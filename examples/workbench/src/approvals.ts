import type { SqlResource } from '@ambionframework/workspace/sql';
import { instruments } from './scenarios.ts';

/** An operation the instrument refused to run until the owner of the exchange answers. */
export interface Approval {
	/** The operation id. `approve_operation` takes it. */
	readonly id: number;
	readonly instrument: string;
	readonly setpoint: number;
	readonly unit: string;
	/** The person whose question opened the exchange. Only this person answers. */
	readonly owner: string;
	/** When the instrument recorded the request, ISO. */
	readonly at: string;
}

const reader = { name: 'assistant', identity: 'Approval reader' };

/** A request stays pending until a later row names it in `request_id`. */
const pending = (room: string): string => `SELECT id, instrument, setpoint, exchange_owner, at
FROM operations AS request
WHERE outcome = 'requested' AND room = '${room.replace(/'/g, "''")}'
AND NOT EXISTS (SELECT 1 FROM operations AS answer WHERE answer.request_id = request.id)
ORDER BY id`;

/** The requested operations of one room that have no answer. The lab records them apart from the journal. */
export function readApprovals(lab: SqlResource, room: string): Promise<Approval[]> {
	return lab.use(reader, (env) =>
		env.query(pending(room)).map((row) => ({
			id: Number(row.id),
			instrument: String(row.instrument),
			setpoint: Number(row.setpoint),
			unit: instruments.find((spec) => spec.name === row.instrument)?.unit ?? '',
			owner: String(row.exchange_owner ?? ''),
			at: String(row.at ?? ''),
		})),
	);
}
