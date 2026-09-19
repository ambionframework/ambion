import tokens from '../../../brand/tokens/ambion.tokens.json' with { type: 'json' };

/**
 * The example reads its identity from the repository brand kit in the root
 * `brand/` directory. The web endpoint links `brand/tokens/ambion.css` and the
 * brand icons. This file gives the terminal endpoint the same colors, from the
 * brand token file, so both surfaces stay on one brand.
 */

const colors = tokens.colors;

/** The product name and its one-line description. */
export const brand = {
	name: 'Ambion',
	product: 'Workbench',
	tagline: 'an agentic lab workbench',
} as const;

/**
 * The terminal palette. The brand colors set the accent, the text, and the
 * background. The UI scaffold colors below sit on top of them.
 */
export const tui = {
	bg: colors.paper,
	panel: colors.white,
	text: colors.ink,
	accent: colors.teal,
	coral: colors.coral,
	muted: colors.muted,
	dim: '#8a969b',
	line: '#e3ddd2',
	red: '#c0473a',
} as const;
