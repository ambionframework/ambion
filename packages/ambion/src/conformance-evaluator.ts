/**
 * The cases every `Evaluator` must pass. The suite gives an evaluator the
 * code of a compose call and the bindings of a scripted host, and checks what
 * the code reads: the globals table, the values that cross as JSON, the
 * errors of a binding, parallel calls, a memory limit, and a cut. It never
 * checks which tool a binding is. The suite needs no test framework, so it
 * runs in Node and in any other host.
 *
 * `make` returns a fresh evaluator for each case. An evaluator that bounds
 * its memory and its CPU time must do so within a few seconds, so `make`
 * sets a small memory limit and a CPU limit under one second when the
 * evaluator keeps them. An evaluator that a cut stops needs neither limit.
 */
import { type ConformanceCase, check } from '@ambionframework/journal/conformance';
import type { Evaluator, EvaluatorInput, JsonValue } from './compose.ts';
import { pause, until } from './conformance-support.ts';

/** How long a case waits for the host side or the evaluator, in milliseconds. */
const PATIENCE = 10_000;

/** What a binding of the scripted host does with its arguments. */
type Handler = (args: JsonValue) => JsonValue | Promise<JsonValue>;

/** A call that the host holds until a case settles it. */
interface Held {
	readonly args: JsonValue;
	resolve(value: JsonValue): void;
}

/** The scripted host: the calls that the code made, and the calls that it holds. */
interface Host {
	readonly calls: { readonly name: string; readonly args: JsonValue }[];
	readonly held: Held[];
	readonly input: Pick<EvaluatorInput, 'call'>;
}

/** The rejection of a binding, as `compose` gives it to an evaluator. */
const rejection = (message: string, details?: JsonValue) =>
	details === undefined ? { message } : { message, details };

function host(handlers: Record<string, Handler> = {}): Host {
	const calls: Host['calls'] = [];
	const held: Held[] = [];
	const hold: Handler = (args) => new Promise((resolve) => held.push({ args, resolve }));
	const all: Record<string, Handler> = {
		hold,
		echo: (args) => ({ got: args }),
		keep: () => null,
		fail: () => Promise.reject(rejection('boom', { code: 7, list: [1] })),
		plainFail: () => Promise.reject(rejection('plain')),
		...handlers,
	};
	return {
		calls,
		held,
		input: {
			async call(name, args) {
				calls.push({ name, args });
				const handler = all[name];
				if (handler === undefined) throw rejection(`The suite binds no tool '${name}'.`);
				return handler(args);
			},
		},
	};
}

interface Options {
	readonly bindings?: readonly string[];
	readonly unlisted?: readonly string[];
	readonly host?: Host;
	readonly signal?: AbortSignal;
	readonly args?: JsonValue;
}

/** Evaluate `code` with the bindings of a scripted host. */
function run(evaluator: Evaluator, code: string, options: Options = {}) {
	const { call } = (options.host ?? host()).input;
	const input: EvaluatorInput = {
		code,
		bindings: options.bindings ?? [],
		...(options.unlisted === undefined ? {} : { unlisted: options.unlisted }),
		call,
		...(options.args === undefined ? {} : { args: options.args }),
	};
	return evaluator.evaluate(input, options.signal ?? new AbortController().signal);
}

/** The error of an evaluation that must fail. It fails the case when the evaluation does not. */
async function failsWith(evaluation: Promise<unknown>, what: string): Promise<Error> {
	let error: unknown;
	try {
		await evaluation;
	} catch (thrown) {
		error = thrown;
	}
	check(error instanceof Error, `${what}: the evaluation did not fail with an Error`);
	return error;
}

/** Fails the case when `actual` and `expected` are not the same JSON. */
function same(actual: unknown, expected: unknown, what: string): void {
	const [a, b] = [JSON.stringify(actual), JSON.stringify(expected)];
	check(a === b, `${what}: expected ${b}, got ${a}`);
}

function mentions(error: Error, parts: readonly string[], what: string): void {
	for (const part of parts) check(error.message.includes(part), `${what}: '${error.message}'`);
}

/** Fails the case when the evaluation stays open past the patience. */
function within<T>(evaluation: Promise<T>, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what}: no end within ${PATIENCE} ms`)), PATIENCE);
	});
	return Promise.race([evaluation, late]).finally(() => clearTimeout(timer));
}

/** Aborts a signal after `ms`, and clears the timer when the case ends. */
function cutAfter(ms: number): { signal: AbortSignal; clear(): void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

const THROWS = 'const throws = (f) => { try { f(); return false; } catch (e) { return true; } };';

type Body = (evaluator: Evaluator) => Promise<void>;

const globalCases: readonly (readonly [string, Body])[] = [
	[
		'throws at Date.now(), Date(), and new Date()',
		async (evaluator) => {
			const value = await run(
				evaluator,
				`${THROWS} return [throws(() => Date.now()), throws(() => Date()), throws(() => new Date()),
					throws(() => new (new Date(0).constructor)()), throws(() => Reflect.construct(Date, []))];`,
			);
			same(value, [true, true, true, true, true], 'the clock');
		},
	],
	[
		'reads new Date(value), Date.UTC, and Date.parse',
		async (evaluator) => {
			const value = await run(
				evaluator,
				`return [new Date(86400000).toISOString(), Date.UTC(2020, 0, 1),
					Date.parse('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z').getTime()];`,
			);
			same(
				value,
				['1970-01-02T00:00:00.000Z', 1577836800000, 1577836800000, 1577836800000],
				'dates',
			);
		},
	],
	[
		'throws at Math.random and keeps the rest of Math',
		async (evaluator) => {
			const value = await run(
				evaluator,
				`${THROWS} return [throws(() => Math.random()), Math.max(1, 2)];`,
			);
			same(value, [true, 2], 'Math');
		},
	],
	[
		'has no WeakRef, FinalizationRegistry, Intl, performance, crypto, timer, or microtask queue',
		async (evaluator) => {
			const names = [
				'WeakRef',
				'FinalizationRegistry',
				'Intl',
				'performance',
				'crypto',
				'setTimeout',
				'setInterval',
				'queueMicrotask',
			];
			const value = await run(
				evaluator,
				`return ${JSON.stringify(names)}.map((name) => typeof globalThis[name]);`,
			);
			same(
				value,
				names.map(() => 'undefined'),
				'absent names',
			);
		},
	],
	[
		'has no require, import, process, or fetch',
		async (evaluator) => {
			const value = await run(
				evaluator,
				`let imported = 'refused';
				try { await import('node:fs'); imported = 'imported'; } catch (e) {}
				return [typeof require, typeof process, typeof fetch, imported];`,
			);
			same(value, ['undefined', 'undefined', 'undefined', 'refused'], 'ambient authority');
		},
	],
	[
		'starts each evaluation with fresh globals',
		async (evaluator) => {
			await run(evaluator, 'globalThis.kept = 1; Array.prototype.extra = 1; return 1;');
			const value = await run(evaluator, 'return [typeof kept, typeof [].extra];');
			same(value, ['undefined', 'undefined'], 'state of an earlier evaluation');
		},
	],
];

const argsCases: readonly (readonly [string, Body])[] = [
	[
		'reads the args as a global, and keeps the host copy of them',
		async (evaluator) => {
			const args = { label: 'drift', list: [1, { deep: [true, null] }] };
			const value = await run(evaluator, 'const seen = args; args.list.push(2); return seen;', {
				args,
			});
			same(value, { label: 'drift', list: [1, { deep: [true, null] }, 2] }, 'the args in the code');
			same(args, { label: 'drift', list: [1, { deep: [true, null] }] }, 'the args of the host');
			same(await run(evaluator, 'return args;', { args: null }), null, 'null args');
		},
	],
	[
		'has no global args when the input has none',
		async (evaluator) => {
			same(await run(evaluator, 'return typeof args;'), 'undefined', 'typeof args');
			const error = await failsWith(run(evaluator, 'return args;'), 'args');
			check(error.message.includes('args'), `the message is '${error.message}'`);
		},
	],
];

const valueCases: readonly (readonly [string, Body])[] = [
	[
		'returns the value of a top-level await, and undefined for no return',
		async (evaluator) => {
			same(
				await run(evaluator, 'return await Promise.resolve([1, { a: null }]);'),
				[1, { a: null }],
				'return',
			);
			check((await run(evaluator, 'await 1;')) === undefined, 'no return gave a value');
			check((await run(evaluator, 'return undefined;')) === undefined, 'undefined gave a value');
		},
	],
	[
		'returns each kind of JSON value, and drops a property that holds undefined',
		async (evaluator) => {
			const value = await run(
				evaluator,
				"return { s: 'x', n: 1.5, b: true, z: null, list: [1, [2]], gone: undefined };",
			);
			same(value, { s: 'x', n: 1.5, b: true, z: null, list: [1, [2]] }, 'JSON value');
		},
	],
	[
		'binds each name as tools.<name> and no other name',
		async (evaluator) => {
			const value = await run(evaluator, "return [Object.keys(tools).sort(), 'c' in tools];", {
				bindings: ['b', 'a'],
			});
			same(value, [['a', 'b'], false], 'the bindings');
		},
	],
	[
		'names the tool and the bound names when code reads a name that it does not bind',
		async (evaluator) => {
			const scripted = host();
			const read = (code: string, unlisted?: readonly string[]) =>
				failsWith(
					run(evaluator, code, {
						bindings: ['bash', 'sql'],
						host: scripted,
						...(unlisted === undefined ? {} : { unlisted }),
					}),
					'unbound',
				);
			const listed = await read('return await tools.wait({});', ['wait']);
			same(
				listed.message,
				'tools.wait is not bound. This call binds bash, sql. Add wait to uses.',
				'a tool of the seat',
			);
			const unknown = await read('return tools.nope;', ['wait']);
			same(
				unknown.message,
				'tools.nope does not exist. This seat has no tool named nope. This call binds bash, sql.',
				'no tool of the seat',
			);
			const unsaid = await read('return tools.wait;');
			check(
				unsaid.message.startsWith('tools.wait is not bound. This call binds bash, sql.'),
				'unsaid',
			);
			check(scripted.calls.length === 0, 'the host saw a call');
		},
	],
	[
		'fails a call to a name that it does not bind, with no call to the host',
		async (evaluator) => {
			const scripted = host();
			const error = await failsWith(
				run(evaluator, 'return await tools.nope({});', { host: scripted }),
				'unbound',
			);
			check(error.message !== '' && scripted.calls.length === 0, 'the host saw a call');
		},
	],
	[
		'passes the arguments to the host and returns its value',
		async (evaluator) => {
			const scripted = host();
			const value = await run(evaluator, 'return await tools.echo({ a: [1, 2] });', {
				bindings: ['echo'],
				host: scripted,
			});
			same(value, { got: { a: [1, 2] } }, 'the binding value');
			same(scripted.calls, [{ name: 'echo', args: { a: [1, 2] } }], 'the calls');
		},
	],
];

/** What JSON cannot hold: how the case names it, an expression that makes it, and the word that the error holds. */
const NOT_JSON = [
	['a function', '{ f: () => 1 }', 'function'],
	['a cycle', '(() => { const a = {}; a.self = a; return a; })()', 'a cycle'],
	['a bigint', '{ n: 10n }', 'bigint'],
	['a Date', '{ d: new Date(0) }', 'Date'],
	['a number that is not finite', '{ n: NaN }', 'NaN'],
	['undefined', 'undefined', 'undefined'],
] as const;

/** The cases for one value that JSON cannot hold: as an argument, and as a return value. */
function notJsonCases(
	kind: string,
	expression: string,
	named: string,
): readonly (readonly [string, Body])[] {
	const asArgument: Body = async (evaluator) => {
		const scripted = host();
		const message = await run(
			evaluator,
			`try { await tools.keep(${expression}); return 'accepted'; } catch (e) { return e.message; }`,
			{ bindings: ['keep'], host: scripted },
		);
		check(typeof message === 'string', 'the call was accepted');
		mentions(new Error(message), ['tools.keep', 'is not JSON', named], `argument with ${kind}`);
		check(scripted.calls.length === 0, 'the host saw the call');
	};
	const asReturn: Body = async (evaluator) => {
		const error = await failsWith(run(evaluator, `return ${expression};`), `return of ${kind}`);
		mentions(error, ['The returned value', 'is not JSON', named], `return with ${kind}`);
	};
	const cases: (readonly [string, Body])[] = [
		[`fails an argument that holds ${kind}, with a named error and no call`, asArgument],
	];
	// A function may return undefined: it is the value of a function with no return.
	if (named !== 'undefined')
		cases.push([`fails a return value that holds ${kind}, with a named error`, asReturn]);
	return cases;
}

const crossingCases: readonly (readonly [string, Body])[] = [
	[
		'copies the arguments of a call when the code makes it',
		async (evaluator) => {
			const scripted = host();
			await run(
				evaluator,
				'const a = { x: [1] }; const p = tools.keep(a); a.x.push(2); a.y = 3; await p; return null;',
				{ bindings: ['keep'], host: scripted },
			);
			same(scripted.calls[0]?.args, { x: [1] }, 'the arguments the host read');
		},
	],
	[
		'copies the value of a binding into the code',
		async (evaluator) => {
			const shared = { x: 1 };
			const scripted = host({ get: () => shared });
			const value = await run(evaluator, 'const r = await tools.get({}); r.x = 2; return r;', {
				bindings: ['get'],
				host: scripted,
			});
			same([value, shared], [{ x: 2 }, { x: 1 }], 'the copies');
		},
	],
	...NOT_JSON.flatMap(([kind, expression, named]) => notJsonCases(kind, expression, named)),
];

const errorCases: readonly (readonly [string, Body])[] = [
	[
		'gives the code an Error with the message and the details of a rejected binding',
		async (evaluator) => {
			const value = await run(
				evaluator,
				`const read = async (name) => {
					try { await tools[name]({}); return null; } catch (e) { return [e instanceof Error, e.message, e.details ?? null, 'details' in e]; }
				};
				return [await read('fail'), await read('plainFail')];`,
				{ bindings: ['fail', 'plainFail'] },
			);
			same(
				value,
				[
					[true, 'boom', { code: 7, list: [1] }, true],
					[true, 'plain', null, false],
				],
				'the rejected binding',
			);
		},
	],
	[
		'fails with the message of a binding error that the code does not catch',
		async (evaluator) => {
			const error = await failsWith(
				run(evaluator, 'return await tools.fail({});', { bindings: ['fail'] }),
				'binding',
			);
			check(error.message === 'boom', `the message is '${error.message}'`);
		},
	],
	[
		'fails with the message of an uncaught throw, and with a syntax error',
		async (evaluator) => {
			const thrown = await failsWith(run(evaluator, "throw new Error('plain');"), 'throw');
			const text = await failsWith(run(evaluator, "throw 'text';"), 'throw of a string');
			const type = await failsWith(run(evaluator, 'return null.x;'), 'type error');
			const syntax = await failsWith(run(evaluator, 'return (;'), 'syntax error');
			check(thrown.message === 'plain' && text.message === 'text', 'the message differs');
			check(type.message !== '' && syntax.message !== '', 'an error has no message');
		},
	],
	[
		'ends with a value or an error when the code changes toJSON',
		async (evaluator) => {
			const ended = run(evaluator, 'Object.prototype.toJSON = () => undefined; return { a: 1 };')
				.then(() => 'value')
				.catch((error: unknown) => (error instanceof Error ? 'error' : 'other'));
			check((await within(ended, 'toJSON')) !== 'other', 'the evaluation failed with a non-error');
		},
	],
	[
		'ignores the rejection of a call that the code drops',
		async (evaluator) => {
			const value = await run(evaluator, "tools.fail({}); await tools.echo({}); return 'ok';", {
				bindings: ['fail', 'echo'],
			});
			same(value, 'ok', 'the dropped rejection');
		},
	],
];

const concurrencyCases: readonly (readonly [string, Body])[] = [
	[
		'runs two calls in flight at once',
		async (evaluator) => {
			const scripted = host();
			const evaluation = run(
				evaluator,
				'const [a, b] = await Promise.all([tools.hold({ n: 1 }), tools.hold({ n: 2 })]); return [a, b];',
				{ bindings: ['hold'], host: scripted },
			);
			await until(() => scripted.held.length === 2, PATIENCE, 'two calls in flight');
			same(
				scripted.held.map((held) => held.args),
				[{ n: 1 }, { n: 2 }],
				'the held arguments',
			);
			scripted.held[1]?.resolve({ done: 2 });
			scripted.held[0]?.resolve({ done: 1 });
			same(await within(evaluation, 'two calls'), [{ done: 1 }, { done: 2 }], 'the values');
		},
	],
	[
		'returns while a call is in flight, and ignores its late value',
		async (evaluator) => {
			const scripted = host();
			const value = await run(evaluator, "tools.hold({}); return 'done';", {
				bindings: ['hold'],
				host: scripted,
			});
			same(value, 'done', 'the value');
			scripted.held[0]?.resolve(1);
			await pause(50);
			same(await run(evaluator, 'return 1;'), 1, 'a later evaluation');
		},
	],
];

const limitCases: readonly (readonly [string, Body])[] = [
	[
		'fails an allocation loop with an error, and serves the next evaluation',
		async (evaluator) => {
			const loop = 'const kept = []; for (;;) kept.push(new Array(10000).fill("x"));';
			await failsWith(within(run(evaluator, loop), 'memory'), 'memory limit');
			same(await run(evaluator, 'return 1;'), 1, 'the evaluation after the limit');
		},
	],
	[
		'fails an allocation loop after an await, with the memory-limit error',
		async (evaluator) => {
			const loop = `await tools.keep({}); const kept = []; for (;;) kept.push(new Array(10000).fill("x"));`;
			const error = await failsWith(
				within(run(evaluator, loop, { bindings: ['keep'] }), 'memory after an await'),
				'memory limit after an await',
			);
			mentions(error, ['memory limit'], 'the error');
			same(await run(evaluator, 'return 1;'), 1, 'the evaluation after the limit');
		},
	],
	[
		'returns the value of code that catches an out-of-memory error after an await',
		async (evaluator) => {
			const loop = `await tools.keep({}); try { const kept = []; for (;;) kept.push(new Array(10000).fill("x")); } catch (e) { return 'caught'; }`;
			// A heap limit that V8 enforces is fatal and no code catches it, so a child process
			// can end with the memory-limit error. An evaluator that can catch it returns the value.
			const outcome = await within(
				run(evaluator, loop, { bindings: ['keep'] }).catch((error: unknown) => error),
				'caught memory',
			);
			if (outcome instanceof Error) mentions(outcome, ['memory limit'], 'the error');
			else same(outcome, 'caught', 'the value of the code');
			same(await run(evaluator, 'return 1;'), 1, 'the evaluation after the limit');
		},
	],
	[
		'ends a busy loop at a cut or at its own CPU limit',
		async (evaluator) => {
			const cut = cutAfter(100);
			try {
				await failsWith(
					within(run(evaluator, 'for (;;) {}', { signal: cut.signal }), 'busy loop'),
					'busy loop',
				);
			} finally {
				cut.clear();
			}
			same(await run(evaluator, 'return 1;'), 1, 'the evaluation after the loop');
		},
	],
	[
		'ends a pending await at a cut, and ignores the late value',
		async (evaluator) => {
			const scripted = host();
			const controller = new AbortController();
			const evaluation = run(evaluator, 'return await tools.hold({});', {
				bindings: ['hold'],
				host: scripted,
				signal: controller.signal,
			});
			await until(() => scripted.held.length === 1, PATIENCE, 'the call in flight');
			controller.abort();
			await failsWith(within(evaluation, 'cut'), 'cut');
			scripted.held[0]?.resolve(1);
			await pause(50);
			same(await run(evaluator, 'return 1;'), 1, 'the evaluation after the cut');
		},
	],
	[
		'fails at once on a signal that is already cut, with no call',
		async (evaluator) => {
			const scripted = host();
			const controller = new AbortController();
			controller.abort();
			await failsWith(
				run(evaluator, 'return await tools.echo({});', {
					bindings: ['echo'],
					host: scripted,
					signal: controller.signal,
				}),
				'cut before the start',
			);
			check(scripted.calls.length === 0, 'the host saw a call');
		},
	],
];

/**
 * The cases of the suite, for the evaluator that `make` returns. Each case
 * calls `make`, so it runs on a fresh evaluator.
 */
export function evaluatorConformance(make: () => Evaluator): readonly ConformanceCase[] {
	const all = [
		...globalCases,
		...argsCases,
		...valueCases,
		...crossingCases,
		...errorCases,
		...concurrencyCases,
		...limitCases,
	];
	return all.map(([name, body]) => ({ name, run: () => body(make()) }));
}
