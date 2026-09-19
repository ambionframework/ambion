/**
 * The rules over the message list, as functions LemmaScript checks.
 * `exchange.ts`, `fold.ts`, `read.ts`, `answers.ts`, and the host's keyed
 * retry run these bodies.
 * `Message` is the public union itself; the stub names the four fields
 * the rules read.
 */

import type { Message } from '../types.ts';
//@ declare-type Message { kind: string, seq: number, from: string, at: string }

//@ contract The last position on an ordered record bounds every position on it; an empty record ends at 0.
export function lastOf(seqs: readonly number[]): number {
	//@ requires forall(i, forall(j, 0 <= i && i < j && j < seqs.length ==> seqs[i] <= seqs[j]))
	//@ requires forall(i, 0 <= i && i < seqs.length ==> seqs[i] >= 1)
	//@ ensures \result >= 0
	//@ ensures seqs.length == 0 ==> \result == 0
	//@ ensures seqs.length > 0 ==> \result == seqs[seqs.length - 1]
	//@ ensures forall(i, 0 <= i && i < seqs.length ==> seqs[i] <= \result)
	return seqs[seqs.length - 1] ?? 0;
}

//@ contract A message opens an exchange when a person spoke it after the last close: agent speech, arrivals and departures open nothing.
function opensExchange(
	message: Message,
	people: readonly string[],
	closedThrough: number,
): boolean {
	//@ ensures \result <==> message.kind == 'said' && people.includes(message.from) && message.seq > closedThrough
	//@ ensures message.kind != 'said' ==> !\result
	//@ ensures message.seq <= closedThrough ==> !\result
	return message.kind === 'said' && people.includes(message.from) && message.seq > closedThrough;
}

//@ contract The open exchange is the first message that opens one after the last close; there is at most one, and its position is on the record.
export function openingQuestion(
	messages: readonly Message[],
	people: readonly string[],
	closedThrough: number,
): Message | undefined {
	//@ requires forall(i, forall(j, 0 <= i && i < j && j < messages.length ==> messages[i].seq < messages[j].seq))
	//@ ensures \result != undefined ==> \result.kind == 'said' && people.includes(\result.from) && \result.seq > closedThrough
	//@ ensures \result == undefined <==> !exists(i, 0 <= i && i < messages.length && opensExchange(messages[i], people, closedThrough))
	//@ ensures \result != undefined ==> exists(i, 0 <= i && i < messages.length && messages[i] == \result && forall(j, 0 <= j && j < i ==> !opensExchange(messages[j], people, closedThrough)))
	//@ ensures \result != undefined ==> messages.length > 0 && \result.seq <= messages[messages.length - 1].seq
	return messages.find((message) => opensExchange(message, people, closedThrough));
}

//@ contract The discussion of an exchange: every non-summary message inside the inclusive range, in record order, and nothing else.
export function discussion(messages: readonly Message[], from: number, through: number): Message[] {
	//@ ensures forall(i, 0 <= i && i < \result.length ==> \result[i].kind != 'summary' && from <= \result[i].seq && \result[i].seq <= through)
	//@ ensures forall(k, 0 <= k && k < messages.length && messages[k].kind != 'summary' && from <= messages[k].seq && messages[k].seq <= through ==> exists(i, 0 <= i && i < \result.length && \result[i] == messages[k]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> messages.includes(\result[i]))
	//@ ensures \result.length <= messages.length
	const out: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		//@ invariant 0 <= i && i <= messages.length
		//@ invariant out.length <= i
		//@ invariant forall(m, 0 <= m && m < out.length ==> out[m].kind != 'summary' && from <= out[m].seq && out[m].seq <= through)
		//@ invariant forall(k, 0 <= k && k < i && messages[k].kind != 'summary' && from <= messages[k].seq && messages[k].seq <= through ==> exists(m, 0 <= m && m < out.length && out[m] == messages[k]))
		//@ invariant forall(m, 0 <= m && m < out.length ==> messages.includes(out[m]))
		const head = messages[i] as Message;
		if (head.kind !== 'summary' && head.seq >= from && head.seq <= through) {
			//@ ghost let before = out
			out.push(head);
			//@ assert forall(m, 0 <= m && m < before.length ==> out[m] == before[m])
			//@ assert out[before.length] == head
		}
	}
	return out;
}

//@ contract A read after a cursor returns exactly the messages past it, and keeps record order when the record is in order.
export function messagesSince(messages: readonly Message[], since: number): Message[] {
	//@ requires forall(a, forall(b, 0 <= a && a < b && b < messages.length ==> messages[a].seq < messages[b].seq))
	//@ ensures \result.length <= messages.length
	//@ ensures forall(i, 0 <= i && i < \result.length ==> \result[i].seq > since)
	//@ ensures forall(i, 0 <= i && i < \result.length ==> messages.includes(\result[i]))
	//@ ensures forall(k, 0 <= k && k < messages.length && messages[k].seq > since ==> \result.includes(messages[k]))
	//@ ensures forall(a, forall(b, 0 <= a && a < b && b < \result.length ==> \result[a].seq < \result[b].seq))
	const out: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		//@ invariant 0 <= i && i <= messages.length
		//@ invariant out.length <= i
		//@ invariant forall(m, 0 <= m && m < out.length ==> out[m].seq > since)
		//@ invariant forall(m, 0 <= m && m < out.length ==> messages.includes(out[m]))
		//@ invariant forall(k, 0 <= k && k < i && messages[k].seq > since ==> out.includes(messages[k]))
		//@ invariant forall(a, forall(b, 0 <= a && a < b && b < out.length ==> out[a].seq < out[b].seq))
		//@ invariant forall(m, 0 <= m && m < out.length ==> forall(k, i <= k && k < messages.length ==> out[m].seq < messages[k].seq))
		const head = messages[i] as Message;
		if (head.seq > since) {
			//@ ghost let before = out
			out.push(head);
			//@ assert forall(m, 0 <= m && m < before.length ==> out[m] == before[m])
			//@ assert out[before.length] == head
		}
	}
	return out;
}

/** Every kind of message on the record. The same union as `Message['kind']` in `types.ts`. */
export type MessageKind = 'said' | 'arrived' | 'left' | 'seated' | 'unseated' | 'summary';

/** A recorded message, as a retry reads it. `text` is empty for a presence change. */
export interface Recorded {
	readonly kind: MessageKind;
	readonly from: string | undefined;
	readonly to: string | undefined;
	readonly text: string;
	readonly subject: string | undefined;
	readonly activationId: string | undefined;
}

/** What a repeated commit asked for, without the recipient a say names. */
export type Contribution =
	| { readonly kind: 'said'; readonly text: string }
	| { readonly kind: 'seated'; readonly name: string }
	| { readonly kind: 'unseated'; readonly name: string };

//@ contract Two optional names agree when both are absent, or both are present and equal.
function sameName(a: string | undefined, b: string | undefined): boolean {
	//@ ensures a == undefined && b == undefined ==> \result
	//@ ensures a == undefined && b != undefined ==> !\result
	//@ ensures a != undefined && b == undefined ==> !\result
	//@ ensures a != undefined && b != undefined ==> (\result <==> a == b)
	if (a === undefined) return b === undefined;
	if (b === undefined) return false;
	return a === b;
}

//@ contract An optional name names a name when it is present and equal.
function namedAs(optional: string | undefined, name: string): boolean {
	//@ ensures optional == undefined ==> !\result
	//@ ensures optional != undefined ==> (\result <==> optional == name)
	if (optional === undefined) return false;
	return optional === name;
}

//@ contract A recorded message answers a person's repeated delivery exactly when it is that person's say, with the same recipient or none in both, the same text, and no activation wrote it.
export function deliveryMatches(
	from: string,
	to: string | undefined,
	text: string,
	message: Recorded,
): boolean {
	//@ ensures \result <==> (message.kind == 'said' && message.activationId == undefined && namedAs(message.from, from) && sameName(message.to, to) && message.text == text)
	//@ ensures \result ==> message.kind == 'said'
	//@ ensures \result ==> message.activationId == undefined
	//@ ensures message.activationId != undefined ==> !\result
	if (message.kind !== 'said') return false;
	if (message.activationId !== undefined) return false;
	if (!namedAs(message.from, from)) return false;
	return sameName(message.to, to) && message.text === text;
}

//@ contract The recorded message is the membership change the intent names.
function sameMembership(
	kind: MessageKind,
	subject: string | undefined,
	intentKind: MessageKind,
	name: string,
): boolean {
	//@ ensures \result <==> (kind == intentKind && namedAs(subject, name))
	return kind === intentKind && namedAs(subject, name);
}

//@ contract A recorded message answers a repeated commit only under the same activation and seat, and then exactly when it is the same contribution: the same membership change, the same say to the same recipient, or a summary with the same text that addresses the recipient the commit names when it names one.
export function contributionMatches(
	activation: string,
	seat: string,
	intent: Contribution,
	to: string | undefined,
	message: Recorded,
): boolean {
	//@ ensures \result ==> namedAs(message.activationId, activation)
	//@ ensures \result ==> namedAs(message.from, seat)
	//@ ensures message.activationId == undefined ==> !\result
	//@ ensures message.kind == 'arrived' || message.kind == 'left' ==> !\result
	//@ ensures intent.kind == 'seated' ==> (\result <==> (namedAs(message.activationId, activation) && namedAs(message.from, seat) && message.kind == 'seated' && namedAs(message.subject, intent.name)))
	//@ ensures intent.kind == 'unseated' ==> (\result <==> (namedAs(message.activationId, activation) && namedAs(message.from, seat) && message.kind == 'unseated' && namedAs(message.subject, intent.name)))
	//@ ensures intent.kind == 'said' && message.kind == 'said' ==> (\result <==> (namedAs(message.activationId, activation) && namedAs(message.from, seat) && sameName(message.to, to) && message.text == intent.text))
	//@ ensures intent.kind == 'said' && message.kind == 'summary' && to == undefined ==> (\result <==> (namedAs(message.activationId, activation) && namedAs(message.from, seat) && message.text == intent.text))
	//@ ensures intent.kind == 'said' && message.kind == 'summary' && to != undefined ==> (\result <==> (namedAs(message.activationId, activation) && namedAs(message.from, seat) && namedAs(message.to, to) && message.text == intent.text))
	//@ ensures intent.kind == 'said' && message.kind != 'said' && message.kind != 'summary' ==> !\result
	//@ ensures \result && intent.kind == 'said' ==> message.text == intent.text
	if (!namedAs(message.activationId, activation)) return false;
	if (!namedAs(message.from, seat)) return false;
	if (intent.kind === 'seated')
		return sameMembership(message.kind, message.subject, 'seated', intent.name);
	if (intent.kind === 'unseated')
		return sameMembership(message.kind, message.subject, 'unseated', intent.name);
	if (message.kind === 'said') return sameName(message.to, to) && message.text === intent.text;
	if (message.kind !== 'summary') return false;
	if (to !== undefined && !namedAs(message.to, to)) return false;
	return message.text === intent.text;
}
