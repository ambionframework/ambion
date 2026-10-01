/** Helpers for the SN35 lifecycle acceptance run on the provisioned OpenSSH tier. */

import { randomUUID } from 'node:crypto';
import { defineAgent, defineHuman, type Message, startRoom } from '@ambionframework/ambion';
import { callTool, isClosing, quiet, scripted, settled } from '@ambionframework/ambion/testing';
import type { Workspace } from '@ambionframework/workspace';

export interface Action {
	readonly tool: string;
	readonly args: (results: readonly { tool: string; text: string }[]) => Record<string, unknown>;
	readonly verify?: (text: string, prior: readonly { tool: string; text: string }[]) => void;
}

type ToolText = { tool: string; text: string };

export interface RoomRun {
	readonly results: readonly { tool: string; text: string }[];
	readonly messages: readonly Message[];
}

/** Run tool calls as one scripted seat in a real room, and return every result. */
export async function runToolRoom(
	workspace: Workspace,
	name: string,
	actions: readonly Action[],
): Promise<RoomRun> {
	const results: ToolText[] = [];
	let recorded = 0;
	let started = false;
	let completed = false;
	let failure: { index: number; tool: string; error: unknown } | undefined;
	const recordResults = (incoming: readonly ToolText[]): boolean => {
		for (; recorded < incoming.length; recorded += 1) {
			const result = incoming[recorded];
			if (result === undefined) continue;
			results.push(result);
			try {
				actions[recorded]?.verify?.(result.text, results.slice(0, -1));
			} catch (error) {
				failure = { index: recorded, tool: result.tool, error };
				completed = true;
				return false;
			}
		}
		return true;
	};
	const invoke = (index: number, next: Action, incoming: readonly ToolText[]) => {
		try {
			return callTool(next.tool, next.args(incoming));
		} catch (error) {
			failure = { index, tool: next.tool, error };
			completed = true;
			return quiet();
		}
	};
	const tools = workspace.tools();
	const agent = defineAgent({
		name,
		identity: `Runs the ${name} workstation lifecycle tools.`,
		executor: {
			kind: 'scripted',
			instructions: 'Run each requested workspace tool in order.',
			tools: tools.tools,
			...(tools.guidance === undefined ? {} : { guidance: tools.guidance }),
			...(tools.remind === undefined ? {} : { reminders: [tools.remind] }),
		},
	});
	const room = await startRoom({
		name: `sn35-${randomUUID().slice(0, 8)}`,
		agents: [agent],
		execution: scripted((step) => {
			if (!started || completed || isClosing(step.view)) return quiet();
			if (!recordResults(step.results)) return quiet();
			const next = actions[step.results.length];
			if (next === undefined) {
				completed = true;
				return quiet();
			}
			return invoke(step.results.length, next, step.results);
		}),
	});
	try {
		const visit = await room.visit(
			defineHuman({ name: 'sn35-operator', identity: 'Runs acceptance.' }),
		);
		await settled(room);
		started = true;
		const exchange = await visit.send({ text: 'Run the workstation sensor lifecycle acceptance.' });
		await exchange.waitForClose();
		if (failure !== undefined) {
			const detail = failure.error instanceof Error ? failure.error.message : String(failure.error);
			throw new Error(
				`Workspace action ${failure.index + 1} (${failure.tool}) failed its acceptance check: ${detail}`,
				{ cause: failure.error },
			);
		}
		if (results.length !== actions.length)
			throw new Error(
				`The room completed ${results.length} of ${actions.length} workspace tool calls.`,
			);
		return { results, messages: (await room.read()).messages };
	} finally {
		await room.stop();
	}
}

/** One fixed tool call in a scripted room. */
export const action = (
	tool: string,
	args: Record<string, unknown>,
	verify?: Action['verify'],
): Action => ({
	tool,
	args: () => args,
	...(verify === undefined ? {} : { verify }),
});

/** Resolve an action's parameters from all earlier tool results. */
export const dynamicAction = (
	tool: string,
	args: Action['args'],
	verify?: Action['verify'],
): Action => ({ tool, args, ...(verify === undefined ? {} : { verify }) });

/** Require a workspace bash result to prove that its process ended with `code`. */
export function expectExitCode(text: string, code: number, label: string, handle?: string): void {
	const match =
		/^\[Process (bash-[a-f0-9]+)(?: \([^)]+\))? exited with code (-?\d+)\. Output: [^\r\n]*\]$/m.exec(
			text,
		);
	if (match === null || (handle !== undefined && match[1] !== handle)) {
		throw new Error(`${label} did not finish before the next action: ${text}`);
	}
	const actual = Number(match[2]);
	if (actual !== code)
		throw new Error(`${label} exited with code ${actual}, expected ${code}: ${text}`);
}

/** Require a short workspace command to finish successfully before the next action. */
export function expectSuccess(label: string): NonNullable<Action['verify']> {
	return (text) => expectExitCode(text, 0, label);
}

/**
 * Require cancellation to report the requested process as stopped: the
 * state `cancelled`, or exit code 0 when the server ended cleanly inside
 * the grace after `SIGTERM`.
 */
export function expectStopped(handle: string): NonNullable<Action['verify']> {
	return (text) => {
		const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const line = `^\\[Process ${escaped}(?: \\([^)]+\\))? (?:is cancelled|exited with code 0)\\.`;
		if (!new RegExp(line, 'm').test(text)) {
			throw new Error(`Process ${handle} was not confirmed stopped: ${text}`);
		}
	};
}

/** Read the text result for the most recent call of `tool`. */
export function latest(results: readonly { tool: string; text: string }[], tool: string): string {
	const found = [...results].reverse().find((result) => result.tool === tool);
	if (found === undefined) throw new Error(`The scripted room has no ${tool} result.`);
	return found.text;
}

/** Read a running process handle from the text returned by `bash`. */
export function processHandle(text: string): string {
	const handle = /Process (bash-[a-f0-9]+)(?=\s|\))/.exec(text)?.[1];
	if (handle === undefined) throw new Error(`The bash result has no process handle: ${text}`);
	return handle;
}

/** Read the server's selected loopback port from its ready line. */
export function readyPort(text: string): number {
	const port = /READY http:\/\/127\.0\.0\.1:(\d+)/.exec(text)?.[1];
	if (port === undefined) throw new Error(`The process output has no READY port: ${text}`);
	return Number(port);
}

/** Read a retained manifest ref from the observation shown to the agent. */
export function manifestRef(text: string): string {
	const ref = /Snapshot ref: (ambion:\/\/\S+)/.exec(text)?.[1];
	if (ref === undefined) throw new Error(`The observe result has no snapshot ref: ${text}`);
	return ref;
}
