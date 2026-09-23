import type { Message } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { type FeedSource, type FeedView, RoomFeed } from '../src/feed.ts';

const said = (seq: number): Message =>
	({
		seq,
		kind: 'said',
		from: 'assistant',
		text: `message ${seq}`,
		at: '2026-01-01T00:00:00Z',
	}) as Message;

interface TestView extends FeedView {
	name: string;
}

const view = (room: string, messages: Message[]): TestView => ({ name: room, messages });

interface Read {
	room: string;
	since: number;
	resolve: (value: TestView) => void;
	reject: (error: Error) => void;
}

/**
 * A feed on bringup, unless `selected` is false. Its source keeps each read
 * open until the test settles it.
 */
function heldFeed(selected = true) {
	const reads: Read[] = [];
	const source: FeedSource<TestView> = {
		read: (room, since) =>
			new Promise<TestView>((resolve, reject) => {
				reads.push({ room, since, resolve, reject });
			}),
	};
	const feed = new RoomFeed<TestView>(source);
	if (selected) feed.select('bringup');
	return { feed, reads };
}

const seqs = (feed: RoomFeed<TestView>) => feed.messages.map((message) => message.seq);

describe('RoomFeed', () => {
	it('reads one request at a time, so overlapping polls add no duplicate', async () => {
		const { feed, reads } = heldFeed();
		const first = feed.refresh();
		expect(await feed.refresh()).toBeUndefined();
		expect(reads).toHaveLength(1);
		reads[0]?.resolve(view('bringup', [said(2), said(4)]));
		expect(await first).toBeDefined();
		expect(seqs(feed)).toEqual([2, 4]);

		const next = feed.refresh();
		expect(reads[1]?.since).toBe(4);
		reads[1]?.resolve(view('bringup', [said(4), said(6)]));
		await next;
		expect(seqs(feed)).toEqual([2, 4, 6]);
	});

	it('drops a read that ends after the feed moved to another room', async () => {
		const { feed, reads } = heldFeed();
		const stale = feed.refresh();
		feed.select('power');
		const current = feed.refresh();
		expect(reads.map((read) => [read.room, read.since])).toEqual([
			['bringup', 0],
			['power', 0],
		]);
		reads[0]?.resolve(view('bringup', [said(9)]));
		expect(await stale).toBeUndefined();
		expect(seqs(feed)).toEqual([]);

		reads[1]?.resolve(view('power', [said(3)]));
		await current;
		expect(seqs(feed)).toEqual([3]);
	});

	it('drops the result of an earlier visit to the same room', async () => {
		const { feed, reads } = heldFeed();
		const first = feed.refresh();
		feed.select('power');
		feed.select('bringup');
		reads[0]?.resolve(view('bringup', [said(5)]));
		expect(await first).toBeUndefined();
		expect(seqs(feed)).toEqual([]);
	});

	it('reports a failed read of the current room and reads again after it', async () => {
		const { feed, reads } = heldFeed();
		const failed = feed.refresh();
		reads[0]?.reject(new Error('host unreachable'));
		await expect(failed).rejects.toThrow('host unreachable');

		const retry = feed.refresh();
		reads[1]?.resolve(view('bringup', [said(2)]));
		await retry;
		expect(seqs(feed)).toEqual([2]);
	});

	it('swallows a failed read of a room the feed already left', async () => {
		const { feed, reads } = heldFeed();
		const stale = feed.refresh();
		feed.select('power');
		reads[0]?.reject(new Error('old room failed'));
		await expect(stale).resolves.toBeUndefined();
	});

	it('does nothing before a room is selected', async () => {
		const { feed, reads } = heldFeed(false);
		expect(await feed.refresh()).toBeUndefined();
		expect(reads).toHaveLength(0);
	});
});
