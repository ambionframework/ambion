/**
 * An oxlint rule that measures cognitive complexity.
 *
 * A structure that breaks the linear flow costs 1. A structure that also nests
 * costs 1 more for every level it sits inside. A nested function adds a level
 * but costs nothing itself, so a branch inside `describe` -> `it` costs three.
 *
 * The rule replaces Biome's `noExcessiveCognitiveComplexity`, which this
 * repository used before oxlint and which oxlint has no equivalent of. It
 * follows the Sonar specification with the two deviations Biome makes: an
 * `else if` pays for the nesting it sits in, and a `finally` block costs 1.
 * Both deviations are deliberate. They keep the scores, and so the budget in
 * `.oxlintrc.jsonc`, the same numbers Biome measured. The agreement is
 * verified over every function in the tree at every budget from 1 to 20.
 *
 * See `docs/toolchain.md` section 7 for what the budget is for.
 */

/** Structures that cost 1, and add a level to whatever they contain. */
const NESTING = new Set([
	'CatchClause',
	'ConditionalExpression',
	'DoWhileStatement',
	'ForInStatement',
	'ForOfStatement',
	'ForStatement',
	'IfStatement',
	'SwitchStatement',
	'WhileStatement',
]);

/** Structures that cost 1 but add no level. */
const FLAT = new Set(['BreakStatement', 'ContinueStatement', 'LogicalExpression', 'TryStatement']);

const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression']);

/** True when the node sits in a position that its parent does not nest. */
function unnested(node, parent) {
	if (parent.type === 'IfStatement') {
		// A condition adds no level, and an `else if` is not inside its `if`.
		if (parent.test === node) return true;
		return parent.alternate === node && node.type === 'IfStatement';
	}
	if (parent.type === 'ConditionalExpression') return parent.test === node;
	return false;
}

/** How many levels of nesting the node sits inside, functions included. */
function nestingOf(node) {
	let levels = 0;
	for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
		if (FUNCTIONS.has(parent.type)) levels += 1;
		else if (NESTING.has(parent.type) && !unnested(child, parent)) levels += 1;
	}
	return levels;
}

/** An `else` breaks the flow once more, unless it is another `if`. */
function elseCostOf(node) {
	if (node.type !== 'IfStatement') return 0;
	if (!node.alternate) return 0;
	return node.alternate.type === 'IfStatement' ? 0 : 1;
}

/** What one structure costs. A structure that adds no level pays no nesting. */
function costOf(node, nesting) {
	if (node.type === 'LogicalExpression') {
		// `a && b && c` is one sequence and costs 1, not 2.
		const parent = node.parent;
		const inSequence = parent?.type === 'LogicalExpression' && parent.operator === node.operator;
		return inSequence ? 0 : 1;
	}
	if (node.type === 'TryStatement') return node.finalizer ? 1 : 0;
	if (FLAT.has(node.type)) return node.label ? 1 : 0;
	return 1 + nesting + elseCostOf(node);
}

/** The function a structure belongs to, which is the one that pays for it. */
function ownerOf(node) {
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (FUNCTIONS.has(parent.type)) return parent;
	}
	return undefined;
}

const rule = {
	meta: {
		type: 'suggestion',
		docs: { description: 'Enforce a maximum cognitive complexity for every function.' },
		schema: [{ type: 'object', properties: { max: { type: 'integer', minimum: 1 } } }],
	},
	create(context) {
		const max = context.options?.[0]?.max ?? 10;
		const scores = new Map();
		const functions = [];

		const charge = (node) => {
			const owner = ownerOf(node);
			if (!owner) return;
			// `nestingOf` counts the owner, which is not a level inside itself.
			const cost = costOf(node, nestingOf(node) - 1);
			scores.set(owner, (scores.get(owner) ?? 0) + cost);
		};

		const visitor = {
			'Program:exit'() {
				for (const fn of functions) {
					const value = scores.get(fn) ?? 0;
					if (value <= max) continue;
					context.report({
						node: fn,
						message: `This function has a cognitive complexity of ${value}. The maximum allowed is ${max}.`,
					});
				}
			},
		};
		for (const type of [...NESTING, ...FLAT]) visitor[type] = charge;
		for (const type of FUNCTIONS) {
			visitor[type] = (node) => {
				functions.push(node);
			};
		}
		return visitor;
	},
};

export default { meta: { name: 'budget' }, rules: { 'cognitive-complexity': rule } };
