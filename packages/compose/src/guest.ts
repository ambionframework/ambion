/**
 * The script that sets up one JavaScript context for the code of a compose
 * call. Both runtimes run it in a fresh context, so both apply one globals
 * table (`docs/compose.md`). The script evaluates to a function. The host
 * calls that function once with three arguments:
 *
 *   hostCall(name, json)  starts one binding call. It returns a promise of a
 *                         JSON string, or a promise that rejects with the JSON
 *                         string of `{ message, details? }`.
 *   hostDone(json)        reports the end of the code, as the JSON string of
 *                         `{ ok: true, value? }` or `{ ok: false, message }`.
 *   config                the JSON string of `{ code, bindings, unlisted?, args? }`:
 *                         the body of an asynchronous function, the binding names,
 *                         the names of the tools that the seat has and the call
 *                         does not bind, and the macro arguments. With no `args`
 *                         key, the code has no global `args`.
 *
 * The script is plain JavaScript in a string. It runs inside the context, so
 * it imports nothing and shares no value with the host except the two
 * functions and two strings. A global is one property of the object
 * that `globals` returns. The code reads it as a
 * parameter of its function.
 *
 * The string holds no backtick and no `${`, so a template literal can carry it.
 */
export const GUEST = `(function (hostCall, hostDone, configJson) {
	'use strict';
	var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
	var NativeDate = Date;
	var stringify = JSON.stringify;
	var parse = JSON.parse;
	var getPrototypeOf = Object.getPrototypeOf;
	var config = parse(configJson);
	var names = config.bindings;
	var unlisted = config.unlisted;

	function refuse(what, fix) {
		return function () {
			throw new Error(what + ' reads ' + fix + '. Call a tool that gives the value.');
		};
	}

	function clockAndRandom() {
		var clock = function (what) {
			return refuse(what, 'the clock');
		};
		var SafeDate = new Proxy(NativeDate, {
			apply: clock('Date()'),
			construct: function (target, args, newTarget) {
				if (args.length === 0) clock('new Date()')();
				return Reflect.construct(target, args, newTarget);
			},
		});
		NativeDate.now = clock('Date.now()');
		Object.defineProperty(NativeDate.prototype, 'constructor', {
			value: SafeDate,
			writable: true,
			configurable: true,
		});
		globalThis.Date = SafeDate;
		Math.random = refuse('Math.random()', 'a random source');
	}

	function absentNames() {
		[
			'WeakRef', 'FinalizationRegistry', 'Intl', 'performance', 'crypto',
			'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
			'clearImmediate', 'queueMicrotask', 'require', 'process', 'fetch', 'WebAssembly',
		].forEach(function (name) {
			delete globalThis[name];
		});
	}

	function describe(value) {
		if (value === undefined) return 'undefined';
		if (typeof value === 'number') return 'the number ' + value;
		if (typeof value === 'object' && value !== null) {
			var prototype = getPrototypeOf(value);
			var constructor = prototype && prototype.constructor;
			return 'a ' + ((constructor && constructor.name) || 'object');
		}
		return 'a ' + typeof value;
	}

	function notJson(where, what) {
		return new Error(where + ' is not JSON: it holds ' + what + '.');
	}

	function copy(value, where, path) {
		if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
		if (typeof value === 'number' && isFinite(value)) return value;
		if (typeof value !== 'object') throw notJson(where, describe(value));
		if (path.indexOf(value) !== -1) throw notJson(where, 'a cycle');
		var inside = path.concat([value]);
		if (Array.isArray(value)) {
			return value.map(function (item, at) {
				return copy(item, where + '[' + at + ']', inside);
			});
		}
		var prototype = getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw notJson(where, describe(value));
		}
		var result = {};
		Object.keys(value).forEach(function (key) {
			if (value[key] !== undefined) result[key] = copy(value[key], where + '.' + key, inside);
		});
		return result;
	}

	function plain(value, where) {
		return copy(value, where, []);
	}

	function failureOf(text) {
		var failure = parse(text);
		var error = new Error(failure.message);
		if (failure.details !== undefined) error.details = failure.details;
		return error;
	}

	function bind(name) {
		return function (args) {
			var json;
			try {
				json = stringify(plain(args, 'The arguments of tools.' + name));
			} catch (error) {
				return Promise.reject(error);
			}
			return new Promise(function (resolve, reject) {
				hostCall(name, json).then(
					function (text) {
						resolve(parse(text));
					},
					function (text) {
						reject(failureOf(text));
					},
				);
			});
		};
	}

	// The text of a read of a name that the call does not bind. It names the tool and the bound names.
	function unbound(name) {
		var bound = names.length === 0 ? 'This call binds no tool.' : 'This call binds ' + names.join(', ') + '.';
		if (unlisted === undefined) return 'tools.' + name + ' is not bound. ' + bound + ' Add the name to uses.';
		if (unlisted.indexOf(name) !== -1) {
			return 'tools.' + name + ' is not bound. ' + bound + ' Add ' + name + ' to uses.';
		}
		return 'tools.' + name + ' does not exist. This seat has no tool named ' + name + '. ' + bound;
	}

	// A read of a name that is not bound throws. A promise check and JSON encoding read these two names.
	var QUIET = ['then', 'toJSON'];

	function guarded(tools) {
		return new Proxy(tools, {
			get: function (target, key, receiver) {
				if (typeof key === 'string' && !(key in target) && QUIET.indexOf(key) === -1) {
					throw new Error(unbound(key));
				}
				return Reflect.get(target, key, receiver);
			},
		});
	}

	function globals() {
		var tools = Object.create(null);
		names.forEach(function (name) {
			tools[name] = bind(name);
		});
		var scope = { tools: guarded(Object.freeze(tools)) };
		if ('args' in config) scope.args = config.args;
		return scope;
	}

	function messageOf(error) {
		try {
			if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
				return error.message;
			}
			return String(error);
		} catch (ignored) {
			return 'The code threw a value that has no message.';
		}
	}

	async function run() {
		try {
			var scope = globals();
			var keys = Object.keys(scope);
			var body = Reflect.construct(AsyncFunction, keys.concat([config.code]));
			var value = await body.apply(
				undefined,
				keys.map(function (key) {
					return scope[key];
				}),
			);
			return value === undefined ? { ok: true } : { ok: true, value: plain(value, 'The returned value') };
		} catch (error) {
			return { ok: false, message: messageOf(error) };
		}
	}

	clockAndRandom();
	absentNames();
	run().then(function (outcome) {
		var text;
		try {
			text = stringify(outcome);
		} catch (error) {
			text = undefined;
		}
		// The code can change toJSON, so the report can fail to encode. Say so.
		if (typeof text !== 'string') text = '{"ok":false,"message":"The code made its result impossible to encode as JSON."}';
		try {
			hostDone(text);
		} catch (error) {
			hostDone('{"ok":false,"message":"The host refused the report."}');
		}
	});
})`;
