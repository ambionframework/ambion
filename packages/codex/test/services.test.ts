/** How the end of a Codex turn maps to a pass result. */
import { describe, expect, it } from 'vitest';
import { causeOf, passResultOf } from '../src/services.ts';

describe('causeOf', () => {
	it.each([
		'unexpected status 401 Unauthorized: invalid api key',
		'You exceeded your current quota, please check your plan.',
		'Not logged in. Run codex login.',
		'insufficient_quota',
	])('names %j permanent', (text) => {
		expect(causeOf(text)).toBe('permanent');
	});

	it.each([
		'stream error: 529 overloaded_error: try again later',
		'connection reset by peer',
		'something unknown went wrong',
	])('names %j transient', (text) => {
		expect(causeOf(text)).toBe('transient');
	});

	it('reads a permanent status the caller gives', () => {
		expect(causeOf('The request failed.', 403)).toBe('permanent');
		expect(causeOf('The request failed.', 500)).toBe('transient');
		expect(causeOf('The request failed.', null)).toBe('transient');
	});
});

describe('passResultOf', () => {
	it('reports a clean turn as no failure', () => {
		expect(passResultOf()).toEqual({ failed: false });
	});

	it('reports a full context window as a length stop', () => {
		expect(passResultOf('Codex ran out of room in the model context window.')).toEqual({
			failed: false,
			stop: 'length',
		});
	});

	it('reports an authentication refusal as a permanent failure', () => {
		expect(passResultOf('unexpected status 401 Unauthorized')).toEqual({
			failed: true,
			cause: 'permanent',
			message: 'unexpected status 401 Unauthorized',
		});
	});

	it('reports an overloaded provider as a transient failure', () => {
		expect(passResultOf('stream error: 529 overloaded_error')).toMatchObject({
			failed: true,
			cause: 'transient',
		});
	});
});
