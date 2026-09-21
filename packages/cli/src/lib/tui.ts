import type { Message, RoomRead } from '@ambionframework/ambion';
import {
	BoxRenderable,
	createCliRenderer,
	InputRenderable,
	InputRenderableEvents,
	ScrollBoxRenderable,
	TextRenderable,
} from '@opentui/core';
import type { RoomClient } from './client.ts';
import { deriveStatus, type RoomStatus } from './status.ts';

export interface TuiOptions {
	client: RoomClient;
	roomName: string;
	logs: string[];
	signal?: AbortSignal;
}

function messageText(message: Message): string | undefined {
	if (message.kind === 'said') {
		const target = message.to === undefined ? '' : ` -> ${message.to}`;
		return `${message.from}${target}: ${message.text}`;
	}
	if (message.kind === 'summary') return `${message.from} -> ${message.to}: ${message.text}`;
	return undefined;
}

function updateConversation(target: TextRenderable, messages: readonly Message[]): void {
	const visible = messages.flatMap((message) => {
		const text = messageText(message);
		return text === undefined ? [] : [text];
	});
	target.content = visible.join('\n\n') || 'Ask the team a question.';
}

function actionableError(line: string): boolean {
	return /\b(?:error|failed|failure|unauthorized|forbidden|authentication|invalid|timeout|timed out|[45]\d{2})\b/i.test(
		line,
	);
}

function latestError(logs: readonly string[]): string | undefined {
	return [...logs].reverse().find(actionableError);
}

function statusText(status: RoomStatus): string {
	const active = status.participants.some(
		(participant) => participant.kind === 'agent' && participant.status === 'active',
	);
	return [
		status.state === 'working' || active ? 'Working…' : 'Ready',
		...(status.cost === undefined ? [] : [status.cost]),
		...(status.awaiting === undefined ? [] : [`Waiting on ${status.awaiting}`]),
	].join(' · ');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
		content: `Ambion · ${options.roomName}`,
		fg: '#7dd3fc',
	});
	const conversation = new ScrollBoxRenderable(renderer, {
		width: '100%',
		height: '100%',
		flexGrow: 1,
		stickyScroll: true,
		stickyStart: 'bottom',
		scrollY: true,
	});
	const conversationText = new TextRenderable(renderer, { content: 'Loading conversation…' });
	conversation.add(conversationText);
	const activity = new TextRenderable(renderer, { content: 'Connecting…', fg: '#94a3b8' });
	const input = new InputRenderable(renderer, {
		width: '100%',
		placeholder: 'Message the team…',
	});
	root.add(header);
	root.add(conversation);
	root.add(activity);
	root.add(input);
	renderer.root.add(root);
	input.focus();

	let messages: Message[] = [];
	let cursor = 0;
	let exchangeFrom: number | undefined;
	let activityText = 'Connecting…';
	let lastError = latestError(options.logs.splice(0));
	let sending = false;
	let refreshing = false;
	let stopped = false;
	const logs = options.logs;
	const renderActivity = () => {
		activity.content =
			lastError === undefined
				? `${activityText} · Enter sends · Ctrl-C exits`
				: `Error: ${lastError}`;
		activity.fg = lastError === undefined ? '#94a3b8' : '#f87171';
		renderer.requestRender();
	};
	const syncLogError = () => {
		const latest = latestError(logs.splice(0));
		if (latest !== undefined) lastError = latest;
	};
	const showError = (error: unknown) => {
		if (stopped) return;
		lastError = errorMessage(error);
		renderActivity();
	};
	const renderSnapshot = (read: RoomRead): void => {
		if (read.messages.length > 0) {
			messages = [...messages, ...read.messages];
			cursor = messages.at(-1)?.seq ?? cursor;
		}
		const status = deriveStatus(read, exchangeFrom);
		updateConversation(conversationText, messages);
		activityText = statusText(status);
		header.content = `Ambion · ${status.name} · ${status.participants.map((participant) => participant.name).join(', ') || 'no participants'}`;
		renderActivity();
	};
	const pull = async (): Promise<void> => {
		syncLogError();
		const read = await options.client.read(cursor === 0 ? {} : { since: cursor });
		if (!stopped) renderSnapshot(read);
	};
	const refresh = async (): Promise<void> => {
		if (stopped || refreshing) return;
		refreshing = true;
		try {
			await pull();
		} catch (error) {
			showError(error);
		} finally {
			refreshing = false;
		}
	};

	input.on(InputRenderableEvents.ENTER, () => {
		const text = input.value.trim();
		if (text === '' || sending || stopped) return;
		sending = true;
		syncLogError();
		lastError = undefined;
		activityText = 'Sending…';
		renderActivity();
		void options.client
			.send(text)
			.then((exchange) => {
				if (stopped) return;
				if (input.value.trim() === text) input.value = '';
				exchangeFrom = exchange.from;
				activityText = 'Working…';
				renderActivity();
				void refresh();
			})
			.catch(showError)
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
	renderActivity();
	if (options.signal?.aborted) renderer.destroy();
	await refresh();
	await finished;
}
