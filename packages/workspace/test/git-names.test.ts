import { expect, it } from 'vitest';
import { assertAgent, namespaceOf } from '../src/git-names.ts';

it.each(['alpha', 'site-office9', 'a-', 'a'.repeat(100)])(
	'accepts an agent namespace without a length limit: %s',
	(name) => {
		expect(namespaceOf(`${name}/report`)).toBe(name);
		expect(() => assertAgent({ name })).not.toThrow();
	},
);

it.each([
	'',
	'Alpha',
	'9lives',
	'alpha_beta',
	'alpha.beta',
	...['\n', '\r', '\r\n', '\u2028', '\u2029'].map((end) => `alpha${end}`),
])('refuses an invalid namespace: %j', (name) => {
	expect(namespaceOf(`${name}/report`)).toBeUndefined();
	expect(() => assertAgent({ name })).toThrow(/not a namespace/);
});

it.each(['templates', 'shared'])(
	'keeps the reserved namespace %s unavailable to an agent',
	(name) => {
		expect(namespaceOf(`${name}/report`)).toBe(name);
		expect(() => assertAgent({ name })).toThrow(/reserved/);
	},
);
