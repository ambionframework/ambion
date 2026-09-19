import type { Message } from '@ambionframework/ambion';

/** What a feed reads: a room's view, of which it needs only the messages. */
export interface FeedView {
	readonly messages: readonly Message[];
}

/** Where a feed reads a room from. The Workbench host is one source. */
export interface FeedSource<View extends FeedView> {
	read(room: string, since: number): Promise<View>;
}

/**
 * The messages of one room, read one request at a time and merged by position.
 *
 * A second read that starts before the first ends would use the same cursor and
 * append the same messages twice, so an overlapping call does nothing. Each
 * {@link select} starts a new generation. A read from an earlier generation
 * belongs to a room the feed left, so its result and its error are dropped.
 */
export class RoomFeed<View extends FeedView> {
	private readonly source: FeedSource<View>;
	private room = '';
	private generation = 0;
	private cursor = 0;
	private items: Message[] = [];
	private reading = false;

	constructor(source: FeedSource<View>) {
		this.source = source;
	}

	get messages(): readonly Message[] {
		return this.items;
	}

	/** Point the feed at a room. It drops the messages of the room it read before. */
	select(room: string): void {
		this.room = room;
		this.generation += 1;
		this.cursor = 0;
		this.items = [];
		this.reading = false;
	}

	/** Read new messages. Return the room view, or undefined when the read did not apply. */
	async refresh(): Promise<View | undefined> {
		if (this.reading || this.room === '') return undefined;
		this.reading = true;
		const generation = this.generation;
		try {
			const view = await this.source.read(this.room, this.cursor);
			if (generation !== this.generation) return undefined;
			this.merge(view.messages);
			return view;
		} catch (error) {
			if (generation !== this.generation) return undefined;
			throw error;
		} finally {
			if (generation === this.generation) this.reading = false;
		}
	}

	private merge(incoming: readonly Message[]): void {
		const fresh = incoming.filter((message) => message.seq > this.cursor);
		if (fresh.length === 0) return;
		this.items = [...this.items, ...fresh];
		this.cursor = fresh.at(-1)?.seq ?? this.cursor;
	}
}
