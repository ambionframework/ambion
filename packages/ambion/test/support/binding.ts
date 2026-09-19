/**
 * The binding between a rules module and the code that runs it. `mocked`
 * wraps every exported rule so that one case can replace it with a
 * sentinel. `bindings` records which rules a case replaced, and `unbound`
 * names every exported rule no case replaced, so a rule cannot gain an
 * export without a binding case.
 */
import { vi } from 'vitest';

type Rule = (...args: never[]) => unknown;

/** Every exported rule of a module, wrapped so that one case can replace it. */
export function mocked<T extends object>(actual: T): T {
	const wrapped: Record<string, unknown> = { ...(actual as Record<string, unknown>) };
	for (const [name, value] of Object.entries(actual))
		if (typeof value === 'function') wrapped[name] = vi.fn(value as Rule);
	return wrapped as T;
}

export function bindings(modules: Record<string, object>) {
	const bound = new Set<string>();
	const originals = new Map<string, Rule>();
	function nameOf(rule: Rule): string {
		for (const [module, exports] of Object.entries(modules))
			for (const [name, value] of Object.entries(exports))
				if (value === rule) return `${module}.${name}`;
		throw new Error('Not an exported rule.');
	}
	function note(rule: Rule): string {
		const name = nameOf(rule);
		bound.add(name);
		return name;
	}
	return {
		/** The next call answers `value`. */
		once<F extends Rule>(rule: F, value: ReturnType<F>): void {
			note(rule);
			vi.mocked(rule).mockReturnValueOnce(value as never);
		},
		/** The next call runs `impl`. */
		onceWith<F extends Rule>(rule: F, impl: F): void {
			note(rule);
			vi.mocked(rule).mockImplementationOnce(impl as never);
		},
		/** Every call runs `impl` until `restore`. */
		always<F extends Rule>(rule: F, impl: F): void {
			const name = note(rule);
			const mock = vi.mocked(rule);
			const original = mock.getMockImplementation();
			if (original !== undefined) originals.set(name, original as Rule);
			mock.mockImplementation(impl as never);
		},
		/** The rule's own body answers again. */
		restore(rule: Rule): void {
			const original = originals.get(nameOf(rule));
			if (original === undefined) throw new Error('Nothing to restore.');
			vi.mocked(rule).mockImplementation(original as never);
		},
		/** Every exported rule no case replaced. */
		unbound(): string[] {
			const names: string[] = [];
			for (const [module, exports] of Object.entries(modules))
				for (const [name, value] of Object.entries(exports))
					if (typeof value === 'function' && !bound.has(`${module}.${name}`))
						names.push(`${module}.${name}`);
			return names;
		},
	};
}
