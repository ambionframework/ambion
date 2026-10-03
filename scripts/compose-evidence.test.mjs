import { strict as assert } from 'node:assert';
import test from 'node:test';
import { evidenceOf } from './compose-evidence.mjs';

const line = (fields) =>
	JSON.stringify({
		kind: 'pi',
		model: 'm',
		thinking: 'medium',
		case: 'chain',
		tools: ['compose'],
		nested: ['sql', 'snapshot'],
		inputTokens: 100,
		outputTokens: 20,
		wallMs: null,
		outcome: 'passed',
		...fields,
	});

test('one table for each kind, and a kind with no line is skipped', () => {
	const text = evidenceOf(
		[
			line({}),
			line({ case: 'parallel processes', wallMs: 3200, tools: ['compose', 'compose', 'say'] }),
			line({ kind: 'claude' }),
		].join('\n'),
	);
	assert.match(text, /^#### pi\n\n\| Model/);
	assert.match(
		text,
		/\| m \(medium\) \| chain \| compose \(nested: sql, snapshot\) \| 100 \| 20 \| - \| passed \|/,
	);
	assert.match(text, /\| compose ×2, say \(nested: sql, snapshot\) \| 100 \| 20 \| 3\.2 s \|/);
	assert.match(text, /#### claude\n\n\| Model/);
	assert.match(text, /#### codex\n\nSkipped\./);
});

test('a later line for the same kind and case replaces an earlier one', () => {
	const text = evidenceOf([line({ outcome: 'failed: x' }), line({})].join('\n'));
	assert.doesNotMatch(text, /failed: x/);
});
