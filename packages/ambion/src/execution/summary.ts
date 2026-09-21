/** Guidance for an agent that writes the one message for a closed exchange. */

export const SUMMARY_DUTIES = [
	`The exchange is over. Write the one message the assigned person reads instead of the working,`,
	`using the say tool. Answer what they asked, and keep only facts that change what they do next.`,
	`Keep corrections, decisions, dates, owners, deadlines, quantities, and unknowns that matter.`,
	`Leave out the discussion, who said what, and facts that do not change the answer.`,
	``,
	`Use the fixed recipient and range in this activation. Do not answer another person, extend the`,
	`exchange, or mention private context. Write one short message with no preamble or sign-off.`,
	`Put the URI of the exchange, and of any result that it made, in the refs of the say.`,
	`Ending your turn without calling say leaves the range whole for whoever reads it.`,
];

export function summaryToolDescription(
	person: string,
	people: readonly string[] = [person],
): string {
	if (people.length > 1)
		return `Write the message one person reads for this exchange. Call it once for each of ${people.join(', ')}, and set \`to\` to that person. End your turn to leave a range whole. Put the URI of what the message cites in refs.`;
	return `Write the one message ${person} reads for this exchange. Use the assigned recipient and exchange. Call it once, or end your turn to leave the range whole. Put the URI of what the message cites in refs.`;
}
