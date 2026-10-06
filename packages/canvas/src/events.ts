/** What a canvas event is about, for the report of a failing listener. */
import type { CanvasEvent, CanvasOperation } from './types.ts';

export const EVENT_OPERATION: Record<CanvasEvent['type'], CanvasOperation> = {
	opened: 'open',
	started: 'start',
	stopped: 'stop',
	archived: 'archive',
	widget: 'widget',
	answered: 'act',
};

/** The room that an event is about. */
export function roomOf(event: CanvasEvent): string {
	if (event.type === 'opened') return event.room.name;
	return event.type === 'widget' ? event.widget.room : event.room;
}
