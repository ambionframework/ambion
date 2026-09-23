import { defineTool, type ToolBundle, type ToolContext } from '@ambionframework/ambion';
import type { SqlProvenance, SqlResource, SqlResourceEnv } from '@ambionframework/workspace/sql';
import { Type } from 'typebox';

/** One simulated instrument. An operation above `limit` needs the approval of a person. */
interface InstrumentSpec {
	readonly name: string;
	readonly quantity: string;
	readonly unit: string;
	readonly limit: number;
}

export interface InstrumentOptions {
	/** The lab resource. The instrument appends to its `operations` table. */
	readonly lab: SqlResource;
	readonly instruments: readonly InstrumentSpec[];
}

/** The instrument resource: two tools over the lab database. */
export interface Instrument {
	tools(): ToolBundle;
}

const GUIDANCE =
	'The bench has simulated instruments. Drive one with `operate`. ' +
	'An operation above the safe limit of an instrument does not run. The tool records a request.' +
	'Ask the owner of the exchange to allow or deny that request. ' +
	'When the owner answers, call `approve_operation` with the request id and the decision. ' +
	'The instrument checks the numeric limit. It does not verify who approved, so relay only the answer of the owner. ' +
	'Every operation lands in the operations table with its provenance.';

function provenanceOf(ctx: ToolContext): SqlProvenance {
	return {
		agent: ctx.agent.name,
		...(ctx.room === undefined ? {} : { room: ctx.room }),
		...(ctx.activation === undefined ? {} : { activation: ctx.activation }),
		...(ctx.exchange === undefined
			? {}
			: { exchange_owner: ctx.exchange.owner, exchange_from: String(ctx.exchange.from) }),
		at: new Date().toISOString(),
	};
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
		description: 'The answer of the exchange owner.',
	}),
});

/** Open the instrument over the lab resource. It owns no handle of its own. */
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
			'Record the answer of the exchange owner to a requested operation. Allow runs the operation. Deny refuses it.',
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

function runOperate(
	env: SqlResourceEnv,
	spec: InstrumentSpec,
	setpoint: number,
	ctx: ToolContext,
): string {
	const provenance = provenanceOf(ctx);
	if (setpoint <= spec.limit) {
		const reading = readingOf(setpoint);
		const id = env.record(
			'operations',
			{ instrument: spec.name, setpoint, outcome: 'done', reading },
			provenance,
		);
		return `Operation ${id} done. ${spec.name} at ${setpoint} ${spec.unit}, reading ${reading} ${spec.unit}.`;
	}
	if (!ctx.exchange) {
		throw new Error('An operation above the limit needs an open exchange and its owner.');
	}
	const id = env.record(
		'operations',
		{ instrument: spec.name, setpoint, outcome: 'requested' },
		provenance,
	);
	return (
		`Operation ${id} did not run. The setpoint ${setpoint} ${spec.unit} is above the limit ${spec.limit} ${spec.unit} of ${spec.name}. ` +
		`It exceeds it by ${setpoint - spec.limit} ${spec.unit}. ` +
		`Ask ${ctx.exchange.owner}, the owner of the exchange, to allow or deny operation ${id}. ` +
		`Then call approve_operation with id ${id} and the answer.`
	);
}

function runApprove(
	env: SqlResourceEnv,
	specs: ReadonlyMap<string, InstrumentSpec>,
	id: number,
	decision: 'allow' | 'deny',
	ctx: ToolContext,
): string {
	// The id passed the integer check, so the statement holds no free text.
	const [request] = env.query(
		`SELECT instrument, setpoint FROM operations WHERE id = ${id} AND outcome = 'requested'`,
	);
	if (!request) throw new Error(`No requested operation ${id}.`);
	const name = String(request.instrument);
	const setpoint = Number(request.setpoint);
	const unit = specs.get(name)?.unit ?? '';
	const provenance = provenanceOf(ctx);
	if (decision === 'deny') {
		env.record(
			'operations',
			{ instrument: name, setpoint, outcome: 'denied', request_id: id },
			provenance,
		);
		return `Operation ${id} denied. ${name} stays where it is.`;
	}
	const reading = readingOf(setpoint);
	env.record(
		'operations',
		{ instrument: name, setpoint, outcome: 'approved', request_id: id, reading },
		provenance,
	);
	return `Operation ${id} approved. ${name} at ${setpoint} ${unit}, reading ${reading} ${unit}.`;
}
