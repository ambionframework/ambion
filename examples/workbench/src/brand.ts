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
 * The terminal palette, on the brand's dark surface. Ink is the ground, and paper
 * is the text, as in the reverse logo. Coral keeps its brand meaning as the one
 * warm accent. The other colors are tints derived from the brand hues, chosen so
 * that text measures at least 4.5:1 on ink and a border at least 3:1.
 */
export const tui = {
	bg: colors.ink,
	panel: '#1b3a44',
	text: colors.paper,
	muted: '#a9bcc1',
	dim: '#8ea6ad',
	accent: '#5cc6d8',
	coral: colors.coral,
	summary: '#e6c68f',
	green: '#6fd3a1',
	red: '#ff8f7d',
	line: '#5a8794',
	selected: '#1f4954',
	steer: '#1e4550',
} as const;
