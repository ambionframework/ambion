import {
	inProcessTransport,
	type SeatPort,
	type Transport,
	type Wake,
} from '@ambionframework/ambion/transport';
import type { FixtureState } from './fixture-state.ts';

/** Delay the assistant's first view until both statements are accepted. */
export function fixtureTransport(state: FixtureState): Transport {
	const base = inProcessTransport();
	const queued = new Map<string, { port: SeatPort; wake: Wake }>();
	function blocked(seat: string): boolean {
		if (state.variant !== 'A06/already-corrected') return false;
		if (seat === 'assistant') return !state.spoken('planner');
		return seat === 'planner' && !state.spoken('inventory');
	}
	function flush(): void {
		for (const [activation, entry] of queued) {
			if (blocked(entry.wake.seat)) continue;
			queued.delete(activation);
			void entry.port
				.wake(entry.wake)
				.catch((error: unknown) => state.diagnostics.push(String(error)));
		}
	}
	return {
		connect(room, context) {
			const port = base.connect(
				{
					...room,
					lease: (request) => room.lease(request),
					async view(activation) {
						const result = await room.view(activation);
						if ('view' in result)
							state.contexts.push({
								phase: state.phase,
								agent: context.seat,
								view: structuredClone(result.view),
							});
						return result;
					},
					async commit(request) {
						const result = await room.commit(request);
						if ('committed' in result) {
							state.accepted(result.committed);
							flush();
						}
						return result;
					},
				},
				context,
			);
			return {
				async wake(wake) {
					if (blocked(wake.seat)) queued.set(wake.activation, { port, wake });
					else await port.wake(wake);
				},
				steer: (steer) => port.steer(steer),
				cut: (activation) => {
					queued.delete(activation);
					return port.cut(activation);
				},
			};
		},
	};
}
