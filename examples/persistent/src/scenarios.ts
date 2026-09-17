import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Attention } from '@ambionframework/ambion';

/** These rooms share one project. Each goal suggests a distinct collaboration pattern. */
export const scenarios: {
	name: string;
	goal: string;
	pattern: string;
	prompt: string;
	seats: Record<string, Attention>;
}[] = [
	{
		name: 'design',
		goal: 'Decide the next Relay milestone from customer feedback. Gather independent product and quality perspectives, then record a focused brief.',
		pattern: 'Independent perspectives → one decision',
		prompt:
			'Read the customer feedback. Compare the two strongest priorities, challenge the assumptions, and recommend one small milestone in the brief.',
		seats: { planner: 'named', reviewer: 'named' },
	},
	{
		name: 'delivery',
		goal: 'Implement the agreed Relay milestone. Have the engineer and reviewer inspect the same files, fix concrete issues, and report verification.',
		pattern: 'Implement → review → revise',
		prompt:
			'Make the handoff list show overdue items clearly and remain usable on a phone. Review the changes and fix any concrete issues.',
		seats: { builder: 'named', reviewer: 'named' },
	},
	{
		name: 'launch',
		goal: 'Prepare accurate Relay release notes from the shared brief and implementation. Invite human edits and revise the draft without making unsupported claims.',
		pattern: 'Draft → human feedback → revision',
		prompt:
			'Draft short release notes from the current prototype and brief. Check every feature claim, and flag anything that needs my decision.',
		seats: { writer: 'named', reviewer: 'named' },
	},
	{
		name: 'triage',
		goal: 'Triage customer reports for Relay. Bring in the right specialist, distinguish bugs from wording problems, and prepare a response draft.',
		pattern: 'Triage → specialist handoff',
		prompt:
			'Triage the reports in tickets.md. Investigate the highest-impact issue, recommend a fix, and draft a response without promising a release date.',
		seats: {},
	},
];

const files: Record<string, string> = {
	'shared/project.md': `# Relay\n\nRelay is a lightweight handoff board for a small service team. Each handoff has an owner, due date, and status. The team wants fewer missed follow-ups without adding a project-management system.\n\nAlice leads product, Bob owns engineering, and Cara leads customer conversations. The next milestone must fit one week. Prioritize clear ownership and mobile use.\n\nThis workspace is shared by design, delivery, launch, and triage rooms. Read before editing. The prototype is a static HTML file, not a deployed service. There is no backend, login, notification delivery, or customer database.\n\nFiles: feedback.md contains interview notes; brief.md records product decisions; prototype.html contains the UI; launch.md holds copy; tickets.md contains fictional customer reports.\n`,
	'shared/feedback.md': `# Customer feedback (fictional)\n\n- Priya, service coordinator: "I need to see what is late before the morning meeting." Uses a phone on site.\n- Mateo, operations lead: "We lose track when a handoff has no owner. More labels will not fix that."\n- June, teammate: "The page is hard to read on my phone. I have to scroll sideways."\n- Priya asked for email reminders. The team has no email integration and one week available.\n\nThese are three interviews, not a representative survey. Validate assumptions before making broad claims.\n`,
	'shared/brief.md': `# Milestone brief\n\nStatus: awaiting a product decision.\n\nGoal: make daily handoffs easier to review.\nConstraints: one week; static prototype; no email service.\nOpen decisions: overdue visibility versus ownership clarity; minimum mobile layout; acceptance criteria.\n`,
	'shared/launch.md': `# Release notes draft\n\nStatus: not written. Verify features against prototype.html and brief.md before making claims.\n`,
	'shared/tickets.md': `# Customer reports (fictional)\n\n## R-17: "Nothing looks late"\nPriya sees a handoff whose due date passed yesterday. It looks like every other row. Status is Open.\n\n## R-18: "I cannot find the owner on my phone"\nJune uses a narrow screen. The table extends outside the viewport.\n\n## R-19: "Did the reminder email send?"\nMateo expects an email reminder. The prototype has no email integration. Clarify the current capability without implying delivery.\n`,
	'shared/prototype.html': `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Relay handoffs</title>
<style>body{font:16px system-ui;margin:32px;color:#243340;background:#f7f9fb}table{border-collapse:collapse;min-width:780px;background:white}td,th{text-align:left;padding:16px;border-bottom:1px solid #dfe5eb}h1{font-size:28px}</style></head>
<body><h1>Today's handoffs</h1><p>Keep the next step clear.</p><table><thead><tr><th>Handoff</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>
<tr><td>Confirm service window</td><td>Priya</td><td data-offset="-1"></td><td>Open</td></tr>
<tr><td>Prepare field notes</td><td>Unassigned</td><td data-offset="0"></td><td>Open</td></tr>
<tr><td>Send completion report</td><td>Mateo</td><td data-offset="1"></td><td>Done</td></tr>
</tbody></table><script>for(const cell of document.querySelectorAll('[data-offset]')){const date=new Date();date.setDate(date.getDate()+Number(cell.dataset.offset));cell.textContent=date.toLocaleDateString();}</script></body></html>
`,
};

/** Add missing sample artifacts. Existing edits always remain intact. */
export async function seedWorkspace(path: string): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		const target = resolve(path, name);
		await mkdir(dirname(target), { recursive: true });
		try {
			await writeFile(target, content, { flag: 'wx' });
		} catch (error) {
			if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
		}
	}
}
