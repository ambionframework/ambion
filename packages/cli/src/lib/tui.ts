import type { Message, SeatInfo } from '@ambionframework/ambion';
import {
	BoxRenderable,
	createCliRenderer,
	InputRenderable,
	InputRenderableEvents,
	ScrollBoxRenderable,
	TextRenderable,
} from '@opentui/core';
import { agentParticipants, type RoomStatus, type WorkerClient } from './client.ts';

const MAX_LOGS = 80;

export interface TuiOptions {
	client: WorkerClient;
	roomName: string;
	logs: string[];
	signal?: AbortSignal;
}

function messageText(message: Message): string {
	if (message.kind === 'said') {
		const target = message.to === undefined ? '' : ` -> ${message.to}`;
		return `${message.from}${target}: ${message.text}`;
	}
	if (message.kind === 'summary') return `${message.from} -> ${message.to}: ${message.text}`;
	return `${message.from} ${message.kind}`;
}

function participantText(participant: SeatInfo): string {
	if (participant.kind === 'human') return `${participant.name} (${participant.presence})`;
	return `${participant.name} (${participant.status})`;
}

function updateMembers(target: TextRenderable, participants: readonly SeatInfo[]): void {
	target.content = participants.map(participantText).join('\n') || 'No participants';
}

function updateLogs(target: TextRenderable, logs: readonly string[]): void {
	target.content = logs.slice(-MAX_LOGS).join('\n') || 'No worker logs';
}

function updateConversation(target: TextRenderable, messages: readonly Message[]): void {
	target.content = messages.map(messageText).join('\n') || 'Ask the team a question.';
}

function updateError(target: TextRenderable, logs: readonly string[]): void {
	const latest = [...logs].reverse().find((line) => /\berror:/i.test(line));
	target.content = latest === undefined ? '' : `Worker error: ${latest}`;
}

function statusText(status: RoomStatus, exchangeState: RoomStatus['exchangeState']): string {
	const agents = agentParticipants(status);
	const active = agents.filter((agent) => agent.status === 'active').length;
	const state = exchangeState === 'working' ? 'working' : exchangeState;
	return `${status.name}  ${state}  ${active} agent${active === 1 ? '' : 's'} active`;
}

/** Run the terminal room until the renderer is destroyed. */
export async function runTerminalRoom(options: TuiOptions): Promise<void> {
	const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 20 });
	const abort = () => renderer.destroy();
	options.signal?.addEventListener('abort', abort, { once: true });
	const root = new BoxRenderable(renderer, {
		flexDirection: 'column',
		width: '100%',
		height: '100%',
		padding: 1,
		gap: 1,
	});
	const header = new TextRenderable(renderer, {
		content: `Ambion team: ${options.roomName}`,
		fg: '#7dd3fc',
	});
	const body = new BoxRenderable(renderer, {
		flexDirection: 'row',
		flexGrow: 1,
		gap: 1,
	});
	const sidebar = new BoxRenderable(renderer, {
		width: 20,
		border: true,
		borderColor: '#334155',
		title: 'Team',
		padding: 1,
	});
	const members = new TextRenderable(renderer, { content: 'Loading team…' });
	const conversationPanel = new BoxRenderable(renderer, {
		flexGrow: 1,
		border: true,
		borderColor: '#334155',
		title: 'Conversation',
		padding: 1,
	});
	const conversation = new ScrollBoxRenderable(renderer, {
		width: '100%',
		height: '100%',
		stickyScroll: true,
		stickyStart: 'bottom',
		scrollY: true,
	});
	const conversationText = new TextRenderable(renderer, { content: 'Loading conversation…' });
	const errorText = new TextRenderable(renderer, { content: '', fg: '#f87171' });
	const logPanel = new BoxRenderable(renderer, {
		width: 24,
		border: true,
		borderColor: '#334155',
		title: 'Worker logs',
		padding: 1,
	});
	const logScroll = new ScrollBoxRenderable(renderer, {
		width: '100%',
		height: '100%',
		stickyScroll: true,
		stickyStart: 'bottom',
		scrollY: true,
	});
	const logText = new TextRenderable(renderer, { content: 'No worker logs' });
	const status = new TextRenderable(renderer, { content: 'Connecting…', fg: '#94a3b8' });
	const inputFrame = new BoxRenderable(renderer, {
		border: true,
		borderColor: '#475569',
		paddingX: 1,
	});
	const input = new InputRenderable(renderer, {
		width: '100%',
		placeholder: 'Message the team (Enter sends, Ctrl-C exits)',
	});
	inputFrame.add(input);

	sidebar.add(members);
	conversation.add(conversationText);
	conversationPanel.add(conversation);
	logScroll.add(logText);
	logPanel.add(logScroll);
	body.add(sidebar);
	body.add(conversationPanel);
	body.add(logPanel);
	root.add(header);
	root.add(body);
	root.add(errorText);
	root.add(status);
	root.add(inputFrame);
	renderer.root.add(root);
	input.focus();

	let messages: Message[] = [];
	let cursor = 0;
	let exchangeFrom: number | undefined;
	let exchangeState: RoomStatus['exchangeState'] = 'idle';
	let sending = false;
	let refreshing = false;
	let stopped = false;
	const logs = options.logs;
	const log = (line: string) => {
		if (stopped) return;
		logs.push(line);
		if (logs.length > MAX_LOGS) logs.shift();
		updateLogs(logText, logs);
		renderer.requestRender();
	};

	const renderSnapshot = (snapshot: RoomStatus, next: Message[]): void => {
		if (next.length > 0) {
			messages = [...messages, ...next];
			cursor = messages.at(-1)?.seq ?? cursor;
			updateConversation(conversationText, messages);
		}
		updateMembers(members, snapshot.participants);
		exchangeState = snapshot.exchangeState;
		if (exchangeFrom !== undefined && exchangeState === 'completed') {
			exchangeFrom = undefined;
		}
		status.content = statusText(snapshot, exchangeState);
		updateError(errorText, logs);
		updateLogs(logText, logs);
		renderer.requestRender();
	};
	const pull = async (): Promise<void> => {
		const snapshot = await options.client.status(exchangeFrom);
		const next = await options.client.messages(cursor === 0 ? undefined : cursor);
		if (!stopped) renderSnapshot(snapshot, next);
	};
	const refresh = async (): Promise<void> => {
		if (stopped || refreshing) return;
		refreshing = true;
		try {
			await pull();
		} catch (error) {
			log(error instanceof Error ? error.message : String(error));
		} finally {
			refreshing = false;
		}
	};

	input.on(InputRenderableEvents.ENTER, () => {
		const text = input.value.trim();
		if (text === '' || sending || stopped) return;
		input.value = '';
		sending = true;
		void options.client
			.send(text)
			.then((exchange) => {
				if (stopped) return;
				exchangeFrom = exchange.from;
				exchangeState = 'working';
				void refresh();
			})
			.catch((error: unknown) => log(error instanceof Error ? error.message : String(error)))
			.finally(() => {
				sending = false;
			});
	});

	let timer: NodeJS.Timeout | undefined;
	const finished = new Promise<void>((resolve) => {
		const finish = () => {
			stopped = true;
			if (timer !== undefined) clearInterval(timer);
			options.signal?.removeEventListener('abort', abort);
			resolve();
		};
		renderer.once('destroy', finish);
	});
	timer = setInterval(() => void refresh(), 500);
	if (options.signal?.aborted) renderer.destroy();
	await refresh();
	await finished;
}
