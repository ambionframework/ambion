import type { ParticipantInfo } from '@ambionframework/ambion';
import {
	BoxRenderable,
	bold,
	type CliRenderer,
	fg,
	StyledText,
	TextRenderable,
} from '@opentui/core';
import { brand, tui as palette } from './brand.ts';
import { fitHeader, GAP } from './header-fit.ts';
import type { Person, RoomView } from './workbench.ts';

type Chunks = ConstructorParameters<typeof StyledText>[0];

/** The cells that the border and the padding take from the panel width. */
const CHROME = 4;

/** True when an agent is at work or a person is present. */
function lit(participant: ParticipantInfo): boolean {
	return participant.kind === 'agent'
		? participant.status === 'active'
		: participant.presence === 'present';
}

/** A participant's color: coral at work, green present, dim otherwise. */
function participantColor(participant: ParticipantInfo): string {
	if (!lit(participant)) return palette.dim;
	return participant.kind === 'agent' ? palette.coral : palette.green;
}

/** A filled dot marks a lit participant, and an empty dot marks the others. The state then reads without color. */
const label = (participant: ParticipantInfo): string =>
	`${lit(participant) ? '●' : '○'} ${participant.name}`;

/** One row of the panel: text at the left edge, and text that stays at the right edge. */
class Row {
	readonly root: BoxRenderable;
	private readonly left: TextRenderable;
	private readonly right: TextRenderable;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, { flexDirection: 'row', gap: GAP });
		this.left = new TextRenderable(renderer, { content: '', flexGrow: 1, wrapMode: 'none' });
		this.right = new TextRenderable(renderer, { content: '', flexShrink: 0, wrapMode: 'none' });
		this.root.add(this.left);
		this.root.add(this.right);
	}

	set(left: Chunks, right: Chunks): void {
		this.left.content = new StyledText(left);
		this.right.content = new StyledText(right);
	}
}

/** What the header shows: who the person is, and the room that is open. */
export interface HeaderState {
	identity: Person | undefined;
	view: RoomView | undefined;
}

/**
 * The panel above the conversation. Its border carries the product name. The
 * first row holds the room name and goal, with the person's identity at the right
 * edge. The second row holds the participants, with the room's pattern at the
 * right edge.
 */
export class Header {
	readonly root: BoxRenderable;
	private readonly room: Row;
	private readonly people: Row;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			flexDirection: 'column',
			flexShrink: 0,
			border: true,
			borderColor: palette.line,
			backgroundColor: palette.panel,
			paddingLeft: 1,
			paddingRight: 1,
			title: `${brand.name} ${brand.product}`,
			titleColor: palette.accent,
		});
		this.room = new Row(renderer);
		this.people = new Row(renderer);
		this.root.add(this.room.root);
		this.root.add(this.people.root);
	}

	/** Draw the state. `width` is the panel width, border included. */
	draw(state: HeaderState, width: number): void {
		const { identity, view } = state;
		const who = identity
			? `as ${identity.name}, ${identity.role.toLowerCase()}`
			: 'choose a person with /user';
		const participants = view?.participants ?? [];
		const fit = fitHeader({
			width: width - CHROME,
			name: view?.name ?? '',
			goal: view?.goal ?? '',
			identity: who,
			people: participants.map(label).join('  ').length,
			pattern: view?.pattern ?? '',
		});
		this.room.set(
			view
				? [bold(fg(palette.accent)(view.name)), fg(palette.dim)(`  ${fit.goal}`)]
				: [fg(palette.dim)('No room open')],
			[fg(palette.muted)(who)],
		);
		this.people.set(
			participants.map((participant) =>
				fg(participantColor(participant))(`${label(participant)}  `),
			),
			[fg(palette.dim)(fit.pattern)],
		);
	}
}
