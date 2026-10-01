import { defineTool, type ToolBundle, type ToolContext } from '@ambionframework/ambion';
import {
	BACKGROUND_CONTEXT,
	type SqlEnv,
	type SqlProvenance,
	type SqlRow,
} from '@ambionframework/workspace';
import type { WorkspaceResource } from '@ambionframework/workspace/resource';
import { Type } from 'typebox';

/** One simulated instrument. An operation above `limit` needs the approval of a person. */
interface InstrumentSpec {
	readonly name: string;
	readonly quantity: string;
	readonly unit: string;
	readonly limit: number;
}

export interface InstrumentOptions {
	/** The resource of the lab database. The instrument appends to its `operations` table. */
	readonly lab: WorkspaceResource<SqlEnv>;
	readonly instruments: readonly InstrumentSpec[];
}

/** The instrument resource: two tools over the lab database. */
export interface Instrument {
	tools(): ToolBundle;
}

const GUIDANCE =
	'The bench has simulated instruments. Drive one with `operate`. ' +
	'An operation above the safe limit of an instrument does not run. The tool records a request.' +
	'Ask the person of the exchange to allow or deny that request. ' +
	'When that person answers, call `approve_operation` with the request id and the decision. ' +
	'The instrument checks the numeric limit. It does not verify who approved, so relay only the answer of that person. ' +
	'Every operation lands in the operations table with its provenance.';

function provenanceOf(ctx: ToolContext): SqlProvenance {
	return {
		agent: ctx.agent.name,
		...(ctx.room === undefined ? {} : { room: ctx.room }),
		...(ctx.activation === undefined ? {} : { activation: ctx.activation }),
		...(ctx.exchange === undefined
			? {}
			: {
					...(ctx.exchange.person === undefined ? {} : { exchange_person: ctx.exchange.person }),
					exchange_from: String(ctx.exchange.from),
				}),
		at: new Date().toISOString(),
	};
}

/**
 * A SQL literal for `value`. The instrument passes its own names, and
 * numbers that the tool schema or the database gave, so each one is finite.
 */
function literal(value: string | number): string {
	return typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`;
}

/** Run one statement on the lab database with the provenance of `ctx`, and give its rows. */
async function labRun(env: SqlEnv, sql: string, ctx: ToolContext): Promise<readonly SqlRow[]> {
	const outcome = await env.run(
		sql,
		{ maxRows: Number.MAX_SAFE_INTEGER, provenance: provenanceOf(ctx) },
		BACKGROUND_CONTEXT,
	);
	if (!outcome.ok) throw new Error(outcome.message);
	return outcome.rows;
}

/** Append one row to `operations`, and give its id. The database fills the provenance. */
async function recordOperation(
	env: SqlEnv,
	values: Readonly<Record<string, string | number>>,
	ctx: ToolContext,
): Promise<number> {
	const names = Object.keys(values).join(', ');
	const literals = Object.values(values).map(literal).join(', ');
	const [row] = await labRun(
		env,
		`INSERT INTO operations (${names}) VALUES (${literals}) RETURNING id`,
		ctx,
	);
	return Number(row?.id);
}

/** The simulated reading is a pure function of the setpoint. */
function readingOf(setpoint: number): number {
	return setpoint;
}

const operateSchema = Type.Object({
	instrument: Type.String({ description: 'The instrument name.' }),
	setpoint: Type.Number({ description: 'The value to drive, in the unit of the instrument.' }),
});

const approveSchema = Type.Object({
	id: Type.Number({ description: 'The operation id that `operate` returned.' }),
	decision: Type.Union([Type.Literal('allow'), Type.Literal('deny')], {
		description: 'The answer of the person of the exchange.',
	}),
});

/** Open the instrument over the lab database. It owns no handle of its own. */
export function openInstrument(options: InstrumentOptions): Instrument {
	const specs = new Map(options.instruments.map((spec) => [spec.name, spec]));
	const known = () => [...specs.keys()].join(', ');

	const operate = defineTool({
		name: 'operate',
		label: 'Operate',
		description: `Drive an instrument to a setpoint. Instruments: ${options.instruments
			.map((spec) => `${spec.name} (${spec.quantity}, limit ${spec.limit} ${spec.unit})`)
			.join('; ')}. An operation above the limit needs approval.`,
		parameters: operateSchema,
		execute: (params, ctx) => {
			const spec = specs.get(params.instrument);
			if (!spec) throw new Error(`Unknown instrument '${params.instrument}'. Known: ${known()}.`);
			return options.lab.use(
				ctx.agent,
				(env) => runOperate(env, spec, params.setpoint, ctx),
				ctx.signal,
			);
		},
	});

	const approve = defineTool({
		name: 'approve_operation',
		label: 'Approve operation',
		description:
			'Record the answer of the person of the exchange to a requested operation. Allow runs the operation. Deny refuses it.',
		parameters: approveSchema,
		execute: (params, ctx) => {
			if (!Number.isInteger(params.id) || params.id < 0) {
				throw new Error('The operation id must be a non-negative integer.');
			}
			return options.lab.use(
				ctx.agent,
				(env) => runApprove(env, specs, params.id, params.decision, ctx),
				ctx.signal,
			);
		},
	});

	return {
		tools: () => Object.freeze({ tools: Object.freeze([operate, approve]), guidance: GUIDANCE }),
	};
}

async function runOperate(
	env: SqlEnv,
	spec: InstrumentSpec,
	setpoint: number,
	ctx: ToolContext,
): Promise<string> {
	if (setpoint <= spec.limit) {
		const reading = readingOf(setpoint);
		const id = await recordOperation(
			env,
			{ instrument: spec.name, setpoint, outcome: 'done', reading },
			ctx,
		);
		return `Operation ${id} done. ${spec.name} at ${setpoint} ${spec.unit}, reading ${reading} ${spec.unit}.`;
	}
	const person = ctx.exchange?.person;
	if (person === undefined) {
		throw new Error('An operation above the limit needs an open exchange where a person spoke.');
	}
	const id = await recordOperation(
		env,
		{ instrument: spec.name, setpoint, outcome: 'requested' },
		ctx,
	);
	return (
		`Operation ${id} did not run. The setpoint ${setpoint} ${spec.unit} is above the limit ${spec.limit} ${spec.unit} of ${spec.name}. ` +
		`It exceeds it by ${setpoint - spec.limit} ${spec.unit}. ` +
		`Ask ${person}, the person of the exchange, to allow or deny operation ${id}. ` +
		`Then call approve_operation with id ${id} and the answer.`
	);
}

async function runApprove(
	env: SqlEnv,
	specs: ReadonlyMap<string, InstrumentSpec>,
	id: number,
	decision: 'allow' | 'deny',
	ctx: ToolContext,
): Promise<string> {
	// The id passed the integer check, so the statement holds no free text.
	const [request] = await labRun(
		env,
		`SELECT instrument, setpoint FROM operations WHERE id = ${id} AND outcome = 'requested'`,
		ctx,
	);
	if (!request) throw new Error(`No requested operation ${id}.`);
	const name = String(request.instrument);
	const setpoint = Number(request.setpoint);
	const unit = specs.get(name)?.unit ?? '';
	if (decision === 'deny') {
		await recordOperation(
			env,
			{ instrument: name, setpoint, outcome: 'denied', request_id: id },
			ctx,
		);
		return `Operation ${id} denied. ${name} stays where it is.`;
	}
	const reading = readingOf(setpoint);
	await recordOperation(
		env,
		{ instrument: name, setpoint, outcome: 'approved', request_id: id, reading },
		ctx,
	);
	return `Operation ${id} approved. ${name} at ${setpoint} ${unit}, reading ${reading} ${unit}.`;
}
