import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSerializable, digestJson } from './json.ts';
import type { EvalReport, EvalStore } from './types.ts';

export function createJsonFileStore(directory: string): EvalStore & {
	loadReport(runId?: string): Promise<EvalReport | undefined>;
} {
	return {
		async saveSample(sample) {
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, `${safeFileName(sample.runId)}-${sampleFileName(sample.sampleId)}.json`),
				JSON.stringify(sample, null, 2),
				{ flag: 'wx' },
			);
		},
		async saveReport(report) {
			await mkdir(directory, { recursive: true });
			const grade =
				report.gradingId === undefined ? 'subject' : `grade-${safeFileName(report.gradingId)}`;
			await writeFile(
				join(directory, `${safeFileName(report.runId)}-${grade}.report.json`),
				JSON.stringify(report, null, 2),
				{ flag: 'wx' },
			);
		},
		async loadReport(runId) {
			try {
				const file = await latestReportFile(directory, runId);
				if (file === undefined) return undefined;
				const report = JSON.parse(await readFile(join(directory, file), 'utf8')) as unknown;
				validateStoredReport(report);
				return report;
			} catch (error) {
				if (isNodeError(error) && error.code === 'ENOENT') return undefined;
				throw error;
			}
		},
	};
}

export class EvalPersistenceError extends Error {
	readonly report: EvalReport;
	constructor(message: string, cause: unknown, report: EvalReport) {
		super(message, { cause });
		this.name = 'EvalPersistenceError';
		this.report = report;
	}
}

function safeFileName(id: string): string {
	return id.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
}

function sampleFileName(id: string): string {
	return `${safeFileName(id).slice(-120)}-${digestJson(id).slice(0, 16)}`;
}

async function latestReportFile(directory: string, runId?: string): Promise<string | undefined> {
	if (runId !== undefined) return `${safeFileName(runId)}-subject.report.json`;
	const files = (await readdir(directory)).filter((file) => file.endsWith('.report.json'));
	const dated = await Promise.all(
		files.map(async (file) => ({ file, modified: (await stat(join(directory, file))).mtimeMs })),
	);
	return dated.sort((a, b) => a.modified - b.modified).at(-1)?.file;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

export function validateStoredReport(value: unknown): asserts value is EvalReport {
	assertSerializable(value, 'stored eval report');
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('Stored eval report must be an object.');
	const report = value as Record<string, unknown>;
	if (report.schemaVersion !== 1) throw new TypeError('Unsupported eval report schema version.');
	if (typeof report.runId !== 'string' || report.runId.length === 0)
		throw new TypeError('Stored eval report has no run ID.');
	if (typeof report.passed !== 'boolean' || !Array.isArray(report.samples))
		throw new TypeError('Stored eval report is incomplete.');
	for (const sample of report.samples) validateStoredSample(sample);
}

function validateStoredSample(value: unknown): void {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('Stored eval sample must be an object.');
	const sample = value as Record<string, unknown>;
	validateSampleIds(sample);
	validateSampleStatus(sample.status);
	validateSampleArrays(sample);
	validateStoredOutcome(sample.outcome);
	validateStoredCollections(sample.collections);
}

function validateSampleIds(sample: Record<string, unknown>): void {
	for (const key of ['runId', 'evalId', 'sampleId', 'attemptId'])
		if (typeof sample[key] !== 'string' || sample[key] === '')
			throw new TypeError(`Stored eval sample has no ${key}.`);
}

function validateSampleStatus(value: unknown): void {
	if (typeof value !== 'string' || !['passed', 'failed', 'error', 'skipped'].includes(value))
		throw new TypeError('Stored eval sample has an invalid status.');
}

function validateSampleArrays(sample: Record<string, unknown>): void {
	if (!Array.isArray(sample.checks) || !Array.isArray(sample.errors))
		throw new TypeError('Stored eval sample is incomplete.');
}

function validateStoredOutcome(value: unknown): void {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('Stored eval sample has no outcome.');
	const outcome = value as Record<string, unknown>;
	if (
		typeof outcome.status !== 'string' ||
		!['success', 'failed', 'timed_out', 'aborted'].includes(outcome.status) ||
		typeof outcome.outputAvailable !== 'boolean' ||
		typeof outcome.halted !== 'boolean' ||
		typeof outcome.unsafeToContinue !== 'boolean' ||
		!Array.isArray(outcome.errors)
	)
		throw new TypeError('Stored eval outcome is incomplete.');
}

function validateStoredCollections(value: unknown): void {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('Stored eval sample has no evidence collections.');
	for (const collection of Object.values(value as Record<string, unknown>))
		validateStoredCollection(collection);
}

function validateStoredCollection(collection: unknown): void {
	if (collection === null || typeof collection !== 'object' || Array.isArray(collection))
		throw new TypeError('Stored evidence collection is invalid.');
	const item = collection as Record<string, unknown>;
	if (
		typeof item.kind !== 'string' ||
		typeof item.complete !== 'boolean' ||
		!('value' in item) ||
		!Array.isArray(item.refs) ||
		item.refs.some((ref) => typeof ref !== 'string')
	)
		throw new TypeError('Stored evidence collection is incomplete.');
}
