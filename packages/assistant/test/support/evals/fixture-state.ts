import type { Message } from '@ambionframework/ambion';
import type { ActivationView } from '@ambionframework/ambion/transport';
import type { AssistantMessage } from '@earendil-works/pi-ai';

export type AssistantVariant =
	| 'A01/named'
	| 'A02/named'
	| 'A02/reserve'
	| 'A03/read'
	| 'A03/no-read'
	| 'A04/reserve'
	| 'A04/broadcast'
	| 'A05/named'
	| 'A05/reserve'
	| 'A06/stale'
	| 'A06/valid'
	| 'A06/already-corrected'
	| 'A07/failure'
	| 'A07/waiting'
	| 'A08/follow-up'
	| 'A09/override'
	| 'A10/dependent';

export interface ProviderCapture {
	agent: string;
	phase: number;
	closing: boolean;
	tools: readonly string[];
	system: string;
	input: string;
	model: string;
	response?: AssistantMessage;
	error?: string;
}
export interface ToolEvent {
	order: number;
	phase: number;
	agent: string;
	tool: string;
	path: string;
	result: string;
	mutated: boolean;
}
export interface RecordedEvent {
	order: number;
	phase: number;
	message: Message;
}
export interface ContextCapture {
	phase: number;
	agent: string;
	view: ActivationView;
}

export const INITIAL_FILES = {
	'/fixtures/R-19.md': 'Private source is inconclusive. Audit marker: private-R19-47.',
};

export class FixtureState {
	phase = 0;
	order = 0;
	readonly provider: ProviderCapture[] = [];
	readonly peerTools: ToolEvent[] = [];
	readonly effects: ToolEvent[] = [];
	readonly record: RecordedEvent[] = [];
	readonly contexts: ContextCapture[] = [];
	readonly diagnostics: string[] = [];
	readonly history: Message[] = [];
	readonly workspace: Record<string, string>;
	readonly workspaceBefore: Record<string, string>;
	readonly pending = new Set<Promise<unknown>>();
	readonly fixtureFacts: Record<string, string>;
	constructor(readonly variant: AssistantVariant) {
		this.fixtureFacts = factsFor(variant);
		this.workspace = { ...INITIAL_FILES };
		if (variant.startsWith('A02'))
			this.workspace['/fixtures/R-19.md'] =
				'Earlier R-19 draft: Email delivery is unsupported. A static preview exists.';
		this.workspaceBefore = { ...this.workspace };
	}
	spoken(agent: string): boolean {
		return this.record.some(
			({ phase, message }) =>
				phase === this.phase && message.kind === 'said' && message.from === agent,
		);
	}
	didTool(agent: string, tool: string): boolean {
		return this.peerTools.some(
			(entry) => entry.phase === this.phase && entry.agent === agent && entry.tool === tool,
		);
	}
	accepted(message: Message): void {
		if (this.record.some((entry) => entry.message.seq === message.seq)) return;
		this.record.push({ order: ++this.order, phase: this.phase, message });
	}
	snapshot() {
		return structuredClone({
			variant: this.variant,
			provider: this.provider,
			peerTools: this.peerTools,
			effects: this.effects,
			fixtureFacts: this.fixtureFacts,
			history: this.history,
			workspaceBefore: this.workspaceBefore,
			workspace: this.workspace,
			record: this.record,
			contexts: this.contexts,
			diagnostics: this.diagnostics,
			visibleFacts: this.record.filter(({ message }) => message.kind === 'said'),
			hiddenFacts: this.peerTools,
		});
	}
}

function factsFor(variant: AssistantVariant): Record<string, string> {
	if (variant.startsWith('A03'))
		return {
			result: 'No verified result. Private work is unknown to the assistant.',
			privateRead: String(variant === 'A03/read'),
		};
	if (variant.startsWith('A02') || variant.startsWith('A05'))
		return {
			scope: 'R-19 only; exactly two sentences; no edits.',
			result:
				'Unsupported email delivery; preview available; neither deployment nor browser checks performed.',
		};
	if (variant.startsWith('A06'))
		return { approved: '8 units', withdrawn: '10 units', permission: 'Do not dispatch.' };
	if (variant === 'A07/failure')
		return { result: 'Stock service unavailable. Capacity unknown. Nothing dispatched.' };
	if (variant === 'A07/waiting')
		return { result: 'Owner authorization is missing. Dispatch remains blocked.' };
	if (variant === 'A08/follow-up')
		return {
			owner: 'Mira',
			artifact: '/prototype/R-19.html',
			correctedQuantity: '8, superseding 10',
			verification: 'Source inspected only. Browser, tests, deployment and release unverified.',
			conflict: 'Email delivery is unsupported; R-19 remains unresolved.',
		};
	if (variant === 'A10/dependent')
		return {
			artifact: '/fixtures/build.txt',
			dependency:
				'Builder writes the artifact before reviewer reads it. A review result is required.',
		};
	return { stock: '8 units of SKU A available today.', permission: 'No dispatch authorized.' };
}
