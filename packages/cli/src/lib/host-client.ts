import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExchangeRef, RoomRead } from '@ambionframework/ambion';
import type { JoinResponse, RoomClient, StartResponse } from './client.ts';

/** What the CLI needs of `src/host.ts` in a generated Node project. */
export interface ProjectHost {
	read(options?: { since?: number }): Promise<RoomRead>;
	join(): Promise<void>;
	send(text: string): Promise<ExchangeRef>;
	close(): Promise<void>;
}

interface HostModule {
	openHost(options: {
		directory: string;
		onError?: (message: string) => void;
	}): Promise<ProjectHost>;
}

export interface HostClient extends RoomClient {
	close(): Promise<void>;
}

/** Wrap a project host as a room client. The terminal treats it like a Worker. */
export function hostClient(host: ProjectHost): HostClient {
	const roster = async (): Promise<RoomRead> => host.read();
	return {
		health: async () => ({ ok: true }),
		async start(): Promise<StartResponse> {
			const read = await roster();
			return { started: read.name, participants: read.participants };
		},
		async join(name = 'human'): Promise<JoinResponse> {
			await host.join();
			return { joined: name, participants: (await roster()).participants };
		},
		send: (text) => host.send(text),
		read: (options) => host.read(options),
		close: () => host.close(),
	};
}

/**
 * Open the room of a generated Node project in this process. The CLI imports
 * the project's own `src/host.ts`, so the room binds the runtime the project
 * installed.
 */
export async function openHostClient(
	directory: string,
	onError?: (message: string) => void,
): Promise<HostClient> {
	const url = pathToFileURL(resolve(directory, 'src', 'host.ts')).href;
	const module = (await import(url)) as HostModule;
	const host = await module.openHost({
		directory: resolve(directory, '.data'),
		...(onError === undefined ? {} : { onError }),
	});
	return hostClient(host);
}
