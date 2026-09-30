/** Helpers for the SN35 lifecycle acceptance run on the provisioned OpenSSH tier. */

import { randomUUID } from 'node:crypto';
import { defineAgent, defineHuman, type Message, startRoom } from '@ambionframework/ambion';
import { callTool, isClosing, quiet, scripted, settled } from '@ambionframework/ambion/testing';
import type { Workspace } from '@ambionframework/workspace';

export interface Action {
	readonly tool: string;
	readonly args: (results: readonly { tool: string; text: string }[]) => Record<string, unknown>;
}

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
	const results: { tool: string; text: string }[] = [];
	let recorded = 0;
	let started = false;
	let completed = false;
	let preparationError: unknown;
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
			for (; recorded < step.results.length; recorded += 1) {
				const result = step.results[recorded];
				if (result !== undefined) results.push(result);
			}
			const next = actions[step.results.length];
			if (next === undefined) {
				completed = true;
				return quiet();
			}
			try {
				return callTool(next.tool, next.args(step.results));
			} catch (error) {
				preparationError = error;
				completed = true;
				return quiet();
			}
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
		if (results.length !== actions.length) {
			const cause = preparationError instanceof Error ? ` ${preparationError.message}` : '';
			throw new Error(
				`The room completed ${results.length} of ${actions.length} workspace tool calls.${cause}`,
			);
		}
		return { results, messages: (await room.read()).messages };
	} finally {
		await room.stop();
	}
}

/** One fixed tool call in a scripted room. */
export const action = (tool: string, args: Record<string, unknown>): Action => ({
	tool,
	args: () => args,
});

/** Resolve an action's parameters from all earlier tool results. */
export const dynamicAction = (tool: string, args: Action['args']): Action => ({ tool, args });

/** Read the text result for the most recent call of `tool`. */
export function latest(results: readonly { tool: string; text: string }[], tool: string): string {
	const found = [...results].reverse().find((result) => result.tool === tool);
	if (found === undefined) throw new Error(`The scripted room has no ${tool} result.`);
	return found.text;
}

/** Read a running process handle from the text returned by `bash`. */
export function processHandle(text: string): string {
	const handle = /Process (bash-[a-f0-9]+)(?: \(| is)/.exec(text)?.[1];
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
