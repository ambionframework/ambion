/**
 * Readers for the native journal captures used by the demo reports. A capture
 * is an ordered list of `{ position, entry }` snapshots. The room body stays
 * nested in `entry.body`; `seq`, `key`, and `run` belong to the journal
 * envelope.
 */

import { decodeActivationId } from '../packages/ambion/src/activation-id.ts';
import { foldLeases as foldLeaseChanges } from '../packages/ambion/src/room/lease.ts';

const object = (value) => value !== null && typeof value === 'object';
const KINDS = new Set(['message', 'lease', 'close', 'composition', 'run']);

/** Return a native envelope, or undefined when a stored snapshot is malformed. */
const envelopeOf = (row) => {
	if (!object(row) || !object(row.entry)) return undefined;
	const entry = row.entry;
	return typeof entry.kind === 'string' && object(entry.body) ? entry : undefined;
};

const rowProblems = (row, entry, number, previousPosition) => {
	const problems = [];
	if (!Number.isInteger(entry.seq) || entry.seq < 1)
		problems.push(`journal row ${number} has an invalid entry seq`);
	if (!KINDS.has(entry.kind)) problems.push(`journal row ${number} has an unsupported entry kind`);
	if (!Number.isInteger(row.position) || row.position < 0)
		problems.push(`journal row ${number} has an invalid storage position`);
	else if (row.position <= previousPosition)
		problems.push(`journal row ${number} is out of storage order`);
	return problems;
};

/** Validate the native envelope before reports derive any metrics from it. */
export const invalidRows = (log) => {
	if (!Array.isArray(log)) return ['journal is not an array'];
	const problems = [];
	let previousPosition = -1;
	for (const [index, row] of log.entries()) {
		const entry = envelopeOf(row);
		if (entry === undefined) {
			problems.push(`journal row ${index + 1} has no native entry envelope`);
			continue;
		}
		problems.push(...rowProblems(row, entry, index + 1, previousPosition));
		if (Number.isInteger(row.position) && row.position >= 0) previousPosition = row.position;
	}
	return problems;
};

/** Every native journal body of one kind, with envelope provenance joined on. */
export const rowsOf = (log, kind) =>
	(log ?? []).flatMap((row) => {
		const entry = envelopeOf(row);
		if (entry?.kind !== kind) return [];
		return [
			{
				...entry.body,
				seq: entry.seq,
				...(entry.key === undefined ? {} : { key: entry.key }),
				...(entry.run === undefined ? {} : { run: entry.run }),
				position: row.position,
			},
		];
	});

/** Raw lease entries in the shape accepted by the room's pure lease fold. */
const leaseEntries = (log) =>
	(log ?? []).flatMap((row) => {
		const entry = envelopeOf(row);
		return entry?.kind === 'lease' ? [{ body: entry.body, seq: entry.seq }] : [];
	});

/** The journal run ids, in the order their fence entries landed. */
export const runsOf = (log) =>
	rowsOf(log, 'run')
		.map((row) => row.run)
		.filter((run) => typeof run === 'string');

/** Which run wrote a body, counted from one, or nothing before the first fence. */
export const writerOf = (runs, row) => {
	const at = runs.indexOf(row?.run);
	return at < 0 ? undefined : at + 1;
};

const leaseProvenance = (rows, runs) => {
	const byId = new Map();
	for (const row of rows) {
		const prior = byId.get(row.id);
		if (!(typeof row.id === 'string' && prior?.ended !== true)) continue;
		switch (row.phase) {
			case 'running':
				if (prior === undefined)
					byId.set(row.id, { claimedRun: row.run, claimedBy: writerOf(runs, row) });
				break;
			case 'ended':
				byId.set(row.id, {
					...(prior ?? {}),
					ended: true,
					endedRun: row.run,
					endedBy: writerOf(runs, row),
				});
				break;
		}
	}
	return byId;
};

/**
 * Fold native lease changes with the room's own lease implementation, then
 * join the envelope provenance needed by the report. A malformed activation
 * id is marked invalid instead of being mistaken for a first attempt.
 */
export function foldLeases(log) {
	const rows = rowsOf(log, 'lease');
	const runs = runsOf(log);
	const byId = leaseProvenance(rows, runs);
	const folded = foldLeaseChanges(leaseEntries(log));
	return [...folded.entries()].map(([id, lease]) => {
		const provenance = byId.get(id) ?? {};
		const parsed = decodeActivationId(id);
		return {
			...lease,
			readThrough: lease.readThrough,
			claimedBy: provenance.claimedBy === undefined ? '—' : `run ${provenance.claimedBy}`,
			endedBy: provenance.endedBy === undefined ? '—' : `run ${provenance.endedBy}`,
			claimedRun: provenance.claimedRun,
			endedRun: provenance.endedRun,
			invalidId: parsed === undefined,
			attempt: parsed?.attempt,
			state: lease.phase === 'ended' ? lease.reason : 'running',
			/** A lease one run claimed and another ended crossed a runtime fence. */
			crossed:
				provenance.claimedRun !== undefined &&
				provenance.endedRun !== undefined &&
				provenance.claimedRun !== provenance.endedRun,
		};
	});
}

/** The attempt encoded by the room's four-part activation id, or undefined. */
export function attemptOf(id) {
	return decodeActivationId(id)?.attempt;
}

export const esc = (s) =>
	String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#x27;');

export const plural = (x, one, many) => `${x} ${x === 1 ? one : many}`;
