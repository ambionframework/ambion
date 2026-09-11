/**
 * The bindings `wrangler.jsonc` declares, as `cloudflare:test` reads them.
 * `wrangler types` would generate this; the tier keeps it by hand, so the
 * file it reads is the file that is checked in.
 */
import type { RoomObject, SeatObject } from '../src/index.ts';

declare global {
	namespace Cloudflare {
		interface Env {
			ROOM: DurableObjectNamespace<RoomObject>;
			SEAT: DurableObjectNamespace<SeatObject>;
		}
	}
}
