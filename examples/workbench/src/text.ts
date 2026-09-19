/** A word edge this close to the cut is a better place to end the text than the cut. */
const EDGE_REACH = 16;

/**
 * Fit text on one line of `width` cells. The result ends with `…` when the text is
 * longer. It ends at a word edge when one lies within a few cells of the cut. It
 * counts each character as one cell, so it fits Latin text and does not measure
 * wide characters.
 */
export function ellipsize(text: string, width: number): string {
	const line = text.replace(/\s+/g, ' ').trim();
	if (line.length <= width) return line;
	if (width < 1) return '';
	const cut = line.slice(0, width - 1);
	const space = cut.lastIndexOf(' ');
	const edge = space > 0 && space >= cut.length - EDGE_REACH ? cut.slice(0, space) : cut;
	return `${edge.trimEnd()}…`;
}
