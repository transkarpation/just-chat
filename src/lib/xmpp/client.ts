import { client, xml, type Client } from '@xmpp/client';
import { goto } from '$app/navigation';
import {
	PUBLIC_XMPP_WS,
	PUBLIC_XMPP_HOST,
	PUBLIC_XMPP_CONFERENCE
} from '$env/static/public';
import { getMyChats } from '$lib/api/chats';
import { chatsState, setChats } from '$lib/state/chats.svelte';
import { xmppState, type XmppStatus } from '$lib/state/xmpp.svelte';
import {
	messagesState,
	ensureRoom,
	prependMessages,
	appendMessage,
	confirmMessage,
	applyReceipt,
	applyDisplayedMarker,
	compareArchiveIds,
	removeMessage,
	replaceMessageBody,
	applyReaction,
	forgetRoom,
	type ChatMessage,
	type MessageMedia,
	type MessageMention
} from '$lib/state/messages.svelte';
import type { UploadedFile } from '$lib/api/files';
import { playMentionSound, playMessageSound } from '$lib/sound';

let xmpp: Client | null = null;
let currentUser = '';
let mamQueryCounter = 0;
const handledInvites = new Set<string>();

/**
 * Marker put into the <status> of the unavailable presence when THIS app
 * leaves a room voluntarily. On the wire a leave is otherwise identical to a
 * connection drop; ejabberd relays the status text to the other occupants
 * (verified live), so their clients can drop the leaver from the member list
 * immediately instead of waiting for a /chats/my refetch. Must be matched
 * exactly — the server writes its own status texts in some cases (e.g.
 * "Replaced by new connection").
 */
const LEAVE_STATUS = 'left-room';

/**
 * Connect to the XMPP server and join the given MUC rooms.
 * The room nickname must equal the xmppUsername (Ethora convention).
 * Safe to call repeatedly: reuses the live connection for the same user
 * and only sends presence to rooms that are not joined yet.
 */
export async function connectAndJoinRooms(
	username: string,
	password: string,
	roomNames: string[]
): Promise<void> {
	if (xmpp && currentUser === username && xmppState.status === 'online') {
		await joinRooms(roomNames, username);
		return;
	}

	await disconnectXmpp();
	currentUser = username;

	xmpp = client({
		service: PUBLIC_XMPP_WS,
		domain: PUBLIC_XMPP_HOST,
		username,
		password
	});

	xmpp.on('status', (status: string) => {
		xmppState.status = status as XmppStatus;
	});

	xmpp.on('error', (err: Error) => {
		console.error('XMPP error:', err.message);
	});

	xmpp.on('stanza', (stanza) => {
		if (!stanza.is('presence')) return;
		const from = String(stanza.attrs.from ?? '');
		const [bareJid, nick] = from.split('/');
		const [room, host] = (bareJid ?? '').split('@');
		if (host !== PUBLIC_XMPP_CONFERENCE || !room) return;

		const type = stanza.attrs.type;

		// unavailable presence from the BARE room JID (no occupant nick):
		// the room was destroyed, or we were removed from its members (the
		// server sends this one only to the affected user) — drop it locally
		if (!nick) {
			if (type === 'unavailable') removeRoomLocally(room);
			return;
		}

		const x = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
		const codes = x?.getChildren('status').map((s) => String(s.attrs.code)) ?? [];

		// occupant roster: the server sends one available presence per occupant
		// on join, then live updates as people come and go
		if (type === 'unavailable') {
			// self-presence with 110 + 321/307/301 (XEP-0045): the owner removed
			// us from the members / we were kicked or banned — the room is gone
			// for this user, drop it locally right away
			if (codes.includes('110') && ['321', '307', '301'].some((c) => codes.includes(c))) {
				removeRoomLocally(room);
				return;
			}
			const occupants = xmppState.occupants[room];
			if (occupants) {
				xmppState.occupants[room] = occupants.filter((n) => n !== nick);
			}
			// another occupant left the room ON PURPOSE (our leave marker in
			// the relayed <status>) — their membership is over, drop them from
			// the member list right away; the backend catches up asynchronously
			if (stanza.getChildText('status') === LEAVE_STATUS) {
				const chat = chatsState.items.find((c) => c.name === room);
				if (chat) {
					chat.members = chat.members.filter((m) => m.xmppUsername !== nick);
				}
			}
		} else if (!type) {
			const occupants = xmppState.occupants[room] ?? [];
			if (!occupants.includes(nick)) {
				xmppState.occupants[room] = [...occupants, nick];
			}
		}

		// a MUC join is confirmed by an AVAILABLE self-presence carrying status
		// code 110 (an unavailable one with 110 is us leaving, not joining)
		if (!type && codes.includes('110') && !xmppState.joinedRooms.includes(room)) {
			xmppState.joinedRooms.push(room);
		}
	});

	// live groupchat messages — including the reflection of our own sends;
	// their <stanza-id> equals the MAM archive id, so dedupe with history is free
	xmpp.on('stanza', (stanza) => {
		if (!stanza.is('message') || stanza.attrs.type !== 'groupchat') return;
		if (stanza.getChild('result', 'urn:xmpp:mam:2')) return; // MAM page, handled elsewhere
		if (stanza.getChild('delay', 'urn:xmpp:delay')) return; // join-time history replay, MAM covers it
		const [bareJid, nick] = String(stanza.attrs.from ?? '').split('/');
		const [room, host] = (bareJid ?? '').split('@');
		if (host !== PUBLIC_XMPP_CONFERENCE || !room || !nick) return;
		// a reflected deletion — the body is empty, only <delete id> matters
		const deleted = stanza.getChild('delete');
		if (deleted?.attrs.id) {
			removeMessage(room, String(deleted.attrs.id));
			return;
		}
		// a reflected edit (bodyless): <replace id text> swaps the body of an
		// earlier message; MAM rewrites the archived entry too (verified live)
		const replace = stanza.getChild('replace');
		if (replace?.attrs.id) {
			replaceMessageBody(room, String(replace.attrs.id), String(replace.attrs.text ?? ''));
			return;
		}
		// a reflected reaction (bodyless): <reactions id> carries the reactor's
		// FULL emoji set for that message (empty = cleared); its own <stanza-id>
		// is the version used to resolve out-of-order updates
		const reactions = stanza.getChild('reactions', 'urn:xmpp:reactions:0');
		if (reactions?.attrs.id) {
			const codes = reactions
				.getChildren('reaction')
				.map((r) => String(r.text() ?? '').trim())
				.filter(Boolean);
			const at = stanza.getChild('stanza-id', 'urn:xmpp:sid:0')?.attrs.id ?? `live-${Date.now()}`;
			applyReaction(room, String(reactions.attrs.id), nick, codes, String(at));
			return;
		}
		// a delivery receipt (bodyless): someone's client confirmed receiving
		// the message with that archive id — reflected to everyone, us included
		const receipt = stanza.getChild('received', 'urn:xmpp:receipts');
		if (receipt?.attrs.id) {
			applyReceipt(room, String(receipt.attrs.id), nick);
			return;
		}
		// a read marker (bodyless): the sender has seen everything up to and
		// including that message
		const displayed = stanza.getChild('displayed', 'urn:xmpp:chat-markers:0');
		if (displayed?.attrs.id) {
			applyDisplayedMarker(room, nick, String(displayed.attrs.id));
			return;
		}
		const body = stanza.getChildText('body');
		if (!body) return;
		const mentions = mentionsMeta(stanza);
		const message: ChatMessage = {
			id:
				stanza.getChild('stanza-id', 'urn:xmpp:sid:0')?.attrs.id ??
				`live-${stanza.attrs.id ?? crypto.randomUUID()}`,
			roomName: room,
			nickname: nick,
			body,
			timestamp: new Date().toISOString(),
			media: mediaMeta(stanza),
			mentions
		};
		// the echo of an own send keeps the stanza id we set (verified live) —
		// use it to turn the optimistic pending copy into the confirmed message
		const sentId = String(stanza.attrs.id ?? '');
		if (nick === currentUser && sentId.startsWith('local-') && confirmMessage(room, sentId, message)) {
			return; // own echo — replaced the pending copy, no sounds for own sends
		}
		appendMessage(room, message);
		const openRoom =
			typeof location !== 'undefined'
				? new URLSearchParams(location.search).get('roomId')
				: null;
		if (nick !== currentUser && stanza.getChild('stanza-id', 'urn:xmpp:sid:0')) {
			// confirm delivery back to the sender (their ✓ becomes ✓✓); only
			// archived messages have an id the receipt can reference
			void sendDeliveryReceipt(room, message.id);
			// the user is looking at this chat right now — it's read, too
			if (openRoom === room && !document.hidden) {
				markRoomDisplayed(room);
			}
		}
		// an audible ping for incoming messages (never for own sends): a loud
		// chime when this user is mentioned; a quiet tick for other messages,
		// but only when they can be missed — hidden tab or a different chat
		if (nick !== currentUser) {
			if (mentions?.some((m) => m.xmppUsername === currentUser)) {
				void playMentionSound();
			} else if (document.hidden || openRoom !== room) {
				void playMessageSound();
			}
		}
		notifyIfBackgrounded(room, nick, body, mentions);
	});

	// mediated MUC invite (XEP-0045) — arrives when someone adds us as a
	// member of a chat; accept it by joining the room
	xmpp.on('stanza', (stanza) => {
		if (!stanza.is('message')) return;
		const muc = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
		if (!muc?.getChild('invite')) return;
		const roomJid =
			stanza.getChild('x', 'jabber:x:conference')?.attrs.jid ?? stanza.attrs.from;
		const [room, host] = String(roomJid ?? '').split('@');
		if (host !== PUBLIC_XMPP_CONFERENCE || !room) return;
		// offline invites can be redelivered on every connect — handle once
		if (handledInvites.has(room)) return;
		handledInvites.add(room);
		void acceptRoomInvite(room);
	});

	xmpp.on('online', async () => {
		// fires on the first connect and on every automatic reconnect; each
		// is a fresh XMPP session, so the server has no presence of ours yet —
		// reset the trackers, announce ourselves, then (re)join the rooms
		xmppState.joinedRooms = [];
		xmppState.occupants = {};
		await xmpp!.send(xml('presence')); // initial presence
		await joinRooms(roomNames, username);
	});

	await xmpp.start();
}

async function joinRooms(roomNames: string[], nickname: string): Promise<void> {
	if (!xmpp) return;
	for (const room of roomNames) {
		if (xmppState.joinedRooms.includes(room)) continue;
		await xmpp.send(
			xml(
				'presence',
				{ to: `${room}@${PUBLIC_XMPP_CONFERENCE}/${nickname}` },
				xml('x', { xmlns: 'http://jabber.org/protocol/muc' })
			)
		);
	}
}

/** Show a browser notification for a live message while the tab is hidden. */
function notifyIfBackgrounded(
	roomName: string,
	nickname: string,
	body: string,
	mentions?: MessageMention[]
): void {
	if (typeof document === 'undefined' || !document.hidden) return;
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
	if (nickname === currentUser) return; // own message reflected back

	const chat = chatsState.items.find((c) => c.name === roomName);
	const member = chat?.members.find((m) => m.xmppUsername === nickname);
	const sender = member
		? `${member.firstName} ${member.lastName}`.trim()
		: (nickname.split('_')[1]?.slice(0, 8) ?? nickname);

	// the server-side title of a private (1-1) chat is unreliable —
	// the sender's name is the natural title there anyway
	let title = (chat?.type === 'private' ? sender : chat?.title) || 'New message';
	if (mentions?.some((m) => m.xmppUsername === currentUser)) {
		title = `${sender} mentioned you`;
	}
	const notification = new Notification(title, {
		body: `${sender}: ${body}`,
		icon: chat?.picture || undefined,
		// one notification per room: a newer message replaces the previous one
		tag: `room-${roomName}`
	});
	notification.onclick = () => {
		window.focus();
		goto(`/?roomId=${encodeURIComponent(roomName)}`);
		notification.close();
	};
}

interface HistoryPage {
	/** oldest → newest, as the archive returns them */
	messages: ChatMessage[];
	/** delivery receipts found in this page (they are archive entries too) */
	receipts: { messageId: string; nickname: string }[];
	/** read markers found in this page */
	markers: { messageId: string; nickname: string }[];
	/** reaction updates found in this page (archive entries of their own) */
	reactions: { targetId: string; nickname: string; codes: string[]; at: string }[];
	/** archive id of the first (oldest) message in this page */
	first: string | null;
	/** true when the page reaches the beginning of the archive */
	complete: boolean;
}

/**
 * Query the room's MAM archive (XEP-0313). Without `beforeId` returns the
 * newest `max` messages; with it — the `max` messages preceding that id.
 */
async function fetchRoomHistory(
	roomName: string,
	opts: { max: number; beforeId?: string }
): Promise<HistoryPage> {
	if (!xmpp || xmppState.status !== 'online') {
		throw new Error('XMPP is not connected');
	}
	const connection = xmpp;
	const roomJid = `${roomName}@${PUBLIC_XMPP_CONFERENCE}`;
	const queryid = `mam-${++mamQueryCounter}`;
	const collected: ChatMessage[] = [];
	const receipts: HistoryPage['receipts'] = [];
	const markers: HistoryPage['markers'] = [];
	const reactions: HistoryPage['reactions'] = [];

	// archived messages arrive as separate stanzas correlated by queryid,
	// while the awaited IQ result only carries the paging metadata
	const onStanza = (stanza: ReturnType<typeof xml>) => {
		if (!stanza.is('message')) return;
		const result = stanza.getChild('result', 'urn:xmpp:mam:2');
		if (!result || result.attrs.queryid !== queryid) return;
		const forwarded = result.getChild('forwarded', 'urn:xmpp:forward:0');
		const message = forwarded?.getChild('message');
		if (!message) return;
		// archived delivery receipts — bodyless entries referencing a message
		const receipt = message.getChild('received', 'urn:xmpp:receipts');
		if (receipt?.attrs.id) {
			receipts.push({
				messageId: String(receipt.attrs.id),
				nickname: String(message.attrs.from ?? '').split('/')[1] ?? ''
			});
			return;
		}
		// archived read markers
		const marker = message.getChild('displayed', 'urn:xmpp:chat-markers:0');
		if (marker?.attrs.id) {
			markers.push({
				messageId: String(marker.attrs.id),
				nickname: String(message.attrs.from ?? '').split('/')[1] ?? ''
			});
			return;
		}
		// archived reactions — bodyless entries; each is the reactor's full set
		// at that point in time, versioned by its own archive id
		const reactionEl = message.getChild('reactions', 'urn:xmpp:reactions:0');
		if (reactionEl?.attrs.id) {
			reactions.push({
				targetId: String(reactionEl.attrs.id),
				nickname: String(message.attrs.from ?? '').split('/')[1] ?? '',
				codes: reactionEl
					.getChildren('reaction')
					.map((r) => String(r.text() ?? '').trim())
					.filter(Boolean),
				at: String(result.attrs.id)
			});
			return;
		}
		const body = message.getChildText('body');
		if (!body) return; // skip other bodyless archive entries
		// deleted messages stay in the archive as tombstones: the body
		// becomes "deleted" and a <deleted> element is attached
		if (message.getChild('deleted')) return;
		collected.push({
			id: String(result.attrs.id),
			roomName,
			nickname: String(message.attrs.from ?? '').split('/')[1] ?? '',
			body,
			timestamp: forwarded?.getChild('delay', 'urn:xmpp:delay')?.attrs.stamp ?? '',
			media: mediaMeta(message),
			mentions: mentionsMeta(message),
			// the archive rewrites edited entries in place and marks them
			edited: message.getChild('replaced') ? true : undefined
		});
	};

	connection.on('stanza', onStanza);
	try {
		const iqResult = await connection.iqCaller.request(
			xml(
				'iq',
				{ type: 'set', to: roomJid },
				xml(
					'query',
					{ xmlns: 'urn:xmpp:mam:2', queryid },
					xml(
						'set',
						{ xmlns: 'http://jabber.org/protocol/rsm' },
						xml('max', {}, String(opts.max)),
						opts.beforeId ? xml('before', {}, opts.beforeId) : xml('before')
					)
				)
			),
			15_000
		);
		const fin = iqResult.getChild('fin', 'urn:xmpp:mam:2');
		const set = fin?.getChild('set', 'http://jabber.org/protocol/rsm');
		return {
			messages: collected,
			receipts,
			markers,
			reactions,
			first: set?.getChildText('first') ?? null,
			complete: fin?.attrs.complete === 'true'
		};
	} finally {
		connection.off('stanza', onStanza);
	}
}

/** Fetch the newest messages of each room that has no history in state yet. */
export async function loadLastMessages(roomNames: string[]): Promise<void> {
	await Promise.all(
		roomNames.map(async (roomName) => {
			if (ensureRoom(roomName).messages.length > 0) return;
			// receipts count as archive entries, so a max:1 page could contain
			// only a receipt and no message — fetch a handful instead
			const page = await fetchRoomHistory(roomName, { max: 10 });
			prependMessages(roomName, page.messages, page.first, page.complete);
			for (const receipt of page.receipts) {
				applyReceipt(roomName, receipt.messageId, receipt.nickname);
			}
			for (const marker of page.markers) {
				applyDisplayedMarker(roomName, marker.nickname, marker.messageId);
			}
			for (const reaction of page.reactions) {
				applyReaction(roomName, reaction.targetId, reaction.nickname, reaction.codes, reaction.at);
			}
			// catch up on deliveries that happened while we were offline: any
			// loaded message from someone else without our receipt gets one now.
			// A receipt is always archived after its message, so if our receipt
			// exists, it is inside this same (newest) page — no false resends.
			for (const message of ensureRoom(roomName).messages) {
				if (message.nickname === currentUser) continue;
				if (message.receivedBy?.includes(currentUser)) continue;
				applyReceipt(roomName, message.id, currentUser); // don't resend on later loads
				void sendDeliveryReceipt(roomName, message.id);
			}
		})
	);
}

/** Load a page of older messages before the oldest one already in state. */
export async function loadOlderMessages(roomName: string, count = 20): Promise<void> {
	const room = ensureRoom(roomName);
	if (room.loading || room.complete) return;
	room.loading = true;
	try {
		const page = await fetchRoomHistory(roomName, {
			max: count,
			beforeId: room.firstArchiveId ?? undefined
		});
		prependMessages(roomName, page.messages, page.first, page.complete);
		// receipts in this window may reference messages of even older pages —
		// applyReceipt parks those until the page with the message arrives
		// (read watermarks don't care: they apply to any id ordering-wise)
		for (const receipt of page.receipts) {
			applyReceipt(roomName, receipt.messageId, receipt.nickname);
		}
		for (const marker of page.markers) {
			applyDisplayedMarker(roomName, marker.nickname, marker.messageId);
		}
		for (const reaction of page.reactions) {
			applyReaction(roomName, reaction.targetId, reaction.nickname, reaction.codes, reaction.at);
		}
	} finally {
		room.loading = false;
	}
}

/**
 * Subscribe to a room via MUC/Sub (urn:xmpp:mucsub:0). This is what makes the
 * backend treat the user as a room member: after subscribing, the room shows
 * up in /v1/chats/my. A plain MUC join presence is not enough for that.
 */
export async function subscribeToRoom(roomName: string, nickname: string): Promise<void> {
	if (!xmpp || xmppState.status !== 'online') {
		throw new Error('XMPP is not connected');
	}
	await xmpp.iqCaller.request(
		xml(
			'iq',
			{ type: 'set', to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}` },
			xml(
				'subscribe',
				{ xmlns: 'urn:xmpp:mucsub:0', nick: nickname },
				xml('event', { node: 'urn:xmpp:mucsub:nodes:messages' }),
				xml('event', { node: 'urn:xmpp:mucsub:nodes:presence' })
			)
		),
		15_000
	);
}

/**
 * Ethora convention for attachments: the file metadata travels in
 * <data isMediafile="true"> elements. The classic format is a single element
 * with the body being the literal "media"; our extension allows several
 * elements in one message (a multi-image send) and a caption in the body.
 */
function mediaMeta(message: ReturnType<typeof xml>): MessageMedia[] | undefined {
	const media = message
		.getChildren('data')
		.filter((data) => data.attrs.isMediafile === 'true' && data.attrs.location)
		.map((data) => ({
			location: String(data.attrs.location),
			locationPreview: String(data.attrs.locationPreview || data.attrs.location),
			mimetype: String(data.attrs.mimetype ?? ''),
			originalName: String(data.attrs.originalName ?? ''),
			size: Number(data.attrs.size) || 0
		}));
	return media.length > 0 ? media : undefined;
}

/**
 * @-mentions travel as XEP-0372 reference elements next to the body:
 * <reference xmlns="urn:xmpp:reference:0" type="mention"
 *            begin=".." end=".." uri="xmpp:<xmppUsername>@host"/>
 * begin/end are UTF-16 indices into the body (we are both writer and reader).
 */
function mentionsMeta(message: ReturnType<typeof xml>): MessageMention[] | undefined {
	const mentions: MessageMention[] = [];
	for (const ref of message.getChildren('reference')) {
		if (ref.attrs.xmlns !== 'urn:xmpp:reference:0' || ref.attrs.type !== 'mention') continue;
		const uri = String(ref.attrs.uri ?? '');
		const xmppUsername = uri.replace(/^xmpp:/, '').split('@')[0];
		const begin = Number(ref.attrs.begin);
		const end = Number(ref.attrs.end);
		if (!xmppUsername || !Number.isInteger(begin) || !Number.isInteger(end) || end <= begin) {
			continue;
		}
		mentions.push({ begin, end, xmppUsername });
	}
	return mentions.length > 0 ? mentions : undefined;
}

/** Remove every local trace of a room the user lost access to
 * (deleted/destroyed by the owner, or the user was removed from it). */
function removeRoomLocally(roomName: string): void {
	if (!chatsState.items.some((chat) => chat.name === roomName)) return;
	setChats(chatsState.items.filter((chat) => chat.name !== roomName));
	forgetRoom(roomName);
	xmppState.joinedRooms = xmppState.joinedRooms.filter((room) => room !== roomName);
	delete xmppState.occupants[roomName];
	handledInvites.delete(roomName);
	// if the deleted room is open right now, leave it for the empty state
	if (typeof location !== 'undefined') {
		const openRoom = new URLSearchParams(location.search).get('roomId');
		if (openRoom === roomName) void goto('/');
	}
}

/**
 * Accept a room invite: subscribe + join, then wait for the backend to list
 * the room in /chats/my (membership propagates asynchronously) and load its
 * last message so the sidebar shows a preview. Stale invites for rooms that
 * no longer exist simply time out here without side effects.
 */
async function acceptRoomInvite(roomName: string): Promise<void> {
	if (chatsState.items.some((chat) => chat.name === roomName)) return;
	try {
		await subscribeToRoom(roomName, currentUser);
		await joinRooms([roomName], currentUser);
		for (let attempt = 0; attempt < 15; attempt++) {
			const chats = await getMyChats();
			setChats(chats.items);
			if (chats.items.some((chat) => chat.name === roomName)) {
				await loadLastMessages([roomName]);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
		console.warn('invite accepted but room never appeared in /chats/my:', roomName);
	} catch (err) {
		console.error('accepting room invite failed:', err);
	}
}

/**
 * Confirm to the room that this client received the message with the given
 * archive id (delivery receipt, XEP-0184 element sent as a groupchat stanza).
 * The room reflects it to every occupant — the sender's ✓ turns into ✓✓ —
 * and the <store> hint archives it so the state survives reloads.
 * Best-effort: a lost receipt only understates delivery.
 */
async function sendDeliveryReceipt(roomName: string, archiveId: string): Promise<void> {
	if (!xmpp || xmppState.status !== 'online') return;
	try {
		await xmpp.send(
			xml(
				'message',
				{ type: 'groupchat', to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}` },
				xml('received', { xmlns: 'urn:xmpp:receipts', id: archiveId }),
				xml('store', { xmlns: 'urn:xmpp:hints' })
			)
		);
	} catch (err) {
		console.error('sending delivery receipt failed:', err);
	}
}

/**
 * Tell the room this user has read everything up to the newest loaded
 * message from someone else (XEP-0333 displayed marker as a groupchat
 * stanza, archived via <store>). One watermark covers the whole backlog, so
 * opening a chat costs a single stanza. No-ops when there is nothing newer
 * than the already-sent watermark, when the tab is hidden, or when offline.
 * Call it whenever the user is actually looking at the room's messages.
 */
export function markRoomDisplayed(roomName: string): void {
	if (typeof document === 'undefined' || document.hidden) return;
	if (!xmpp || xmppState.status !== 'online') return;
	const room = messagesState.rooms[roomName];
	if (!room) return;
	// own messages don't need a read mark — take the newest foreign one
	const newest = room.messages.findLast((m) => !m.pending && m.nickname !== currentUser);
	if (!newest) return;
	const own = room.displayedUpTo[currentUser];
	if (own && compareArchiveIds(newest.id, own) <= 0) return; // already marked
	applyDisplayedMarker(roomName, currentUser, newest.id);
	void (async () => {
		try {
			await xmpp!.send(
				xml(
					'message',
					{ type: 'groupchat', to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}` },
					xml('displayed', { xmlns: 'urn:xmpp:chat-markers:0', id: newest.id }),
					xml('store', { xmlns: 'urn:xmpp:hints' })
				)
			);
		} catch (err) {
			console.error('sending read marker failed:', err);
		}
	})();
}

/**
 * Send a text message to a room. The message goes into state immediately as
 * a pending one; the MUC echo (which keeps the stanza id we set) confirms it —
 * that's the "delivered to server" tick in the UI. A failed send removes the
 * optimistic copy again. Mentions travel as XEP-0372 references.
 */
export async function sendRoomMessage(
	roomName: string,
	body: string,
	mentions?: MessageMention[]
): Promise<void> {
	if (!xmpp || xmppState.status !== 'online') {
		throw new Error('XMPP is not connected');
	}
	const localId = `local-${crypto.randomUUID()}`;
	appendMessage(roomName, {
		id: localId,
		roomName,
		nickname: currentUser,
		body,
		timestamp: new Date().toISOString(),
		mentions,
		pending: true
	});
	try {
		await xmpp.send(
			xml(
				'message',
				{ id: localId, type: 'groupchat', to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}` },
				xml('body', {}, body),
				...(mentions ?? []).map((mention) =>
					xml('reference', {
						xmlns: 'urn:xmpp:reference:0',
						type: 'mention',
						begin: String(mention.begin),
						end: String(mention.end),
						uri: `xmpp:${mention.xmppUsername}@${PUBLIC_XMPP_HOST}`
					})
				)
			)
		);
	} catch (err) {
		removeMessage(roomName, localId);
		throw err;
	}
}

/**
 * Send already-uploaded files (POST /v1/files/) to a room. The stanza follows
 * the Ethora media format — a store hint so the server archives it and the
 * metadata of each file in a <data isMediafile="true"> element — with the
 * body carrying the optional caption instead of the literal "media".
 */
export async function sendMediaMessage(
	roomName: string,
	files: UploadedFile[],
	caption = ''
): Promise<void> {
	if (!xmpp || xmppState.status !== 'online') {
		throw new Error('XMPP is not connected');
	}
	if (files.length === 0) return;
	await xmpp.send(
		xml(
			'message',
			{
				id: `send-media-message:${crypto.randomUUID()}`,
				type: 'groupchat',
				to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}`
			},
			xml('body', {}, caption.trim() || 'media'),
			xml('store', { xmlns: 'urn:xmpp:hints' }),
			...files.map((file) =>
				xml('data', {
					isMediafile: 'true',
					expiresAt: String(file.expiresAt),
					location: file.location,
					locationPreview: file.locationPreview,
					mimetype: file.mimetype,
					originalName: file.originalname,
					size: String(file.size),
					isReply: 'false',
					showInChannel: 'false',
					mainMessage: '',
					push: 'true'
				})
			)
		)
	);
}

/**
 * Leave a room. Dropping the MUC/Sub subscription is what removes the
 * backend membership — the `nick` attribute is required for the backend to
 * register the removal, and it propagates asynchronously (up to ~1 min
 * observed), so the room is removed from local state right away instead of
 * waiting for /chats/my to catch up.
 */
export async function leaveRoom(roomName: string): Promise<void> {
	if (!xmpp || xmppState.status !== 'online') {
		throw new Error('XMPP is not connected');
	}
	await xmpp.iqCaller.request(
		xml(
			'iq',
			{ type: 'set', to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}` },
			xml('unsubscribe', { xmlns: 'urn:xmpp:mucsub:0', nick: currentUser })
		),
		15_000
	);
	// also end the occupant session in the room; the <status> marker tells
	// other clients this is a deliberate exit (not a connection drop) so they
	// can remove us from the member list immediately
	await xmpp.send(
		xml(
			'presence',
			{
				to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}/${currentUser}`,
				type: 'unavailable'
			},
			xml('status', {}, LEAVE_STATUS)
		)
	);
	removeRoomLocally(roomName);
}

/**
 * Delete a message in a room by its archive id. Local state is not touched
 * here: the server reflects the <delete> back to every occupant (us included)
 * and the live handler removes the message then. In the MAM archive the
 * message stays as a tombstone, which history loading filters out.
 */
export async function deleteRoomMessage(roomName: string, messageId: string): Promise<void> {
	if (!xmpp || xmppState.status !== 'online') {
		throw new Error('XMPP is not connected');
	}
	await xmpp.send(
		xml(
			'message',
			{
				id: 'deleteMessageStanza',
				type: 'groupchat',
				to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}`
			},
			xml('body', { xmlns: 'wow' }),
			xml('delete', { id: messageId })
		)
	);
}

/**
 * Edit an own message: a bodyless <replace id="<archive-id>" text="…">
 * stanza. The room reflects it to every occupant (the live handler swaps the
 * body then) and the MAM archive rewrites the original entry in place,
 * adding a <replaced> marker — both verified live against the QA server.
 */
export async function editRoomMessage(
	roomName: string,
	messageId: string,
	text: string
): Promise<void> {
	if (!xmpp || xmppState.status !== 'online') {
		throw new Error('XMPP is not connected');
	}
	await xmpp.send(
		xml(
			'message',
			{
				id: `edit-message-${Date.now()}`,
				type: 'groupchat',
				to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}`
			},
			xml('replace', { id: messageId, text })
		)
	);
}

/**
 * Set this user's reactions on a message (XEP-0444). `codes` is the FULL set
 * of emoji shortcodes to keep — an empty array clears the reactions. The room
 * reflects it to every occupant and the <store> hint archives it (as its own
 * entry, not a rewrite of the target — verified live). Applied optimistically
 * with a synthetic version the real echo then overrides.
 */
export async function setRoomReaction(
	roomName: string,
	targetId: string,
	codes: string[]
): Promise<void> {
	if (!xmpp || xmppState.status !== 'online') {
		throw new Error('XMPP is not connected');
	}
	const firstName = typeof localStorage !== 'undefined' ? (localStorage.getItem('firstName') ?? '') : '';
	const lastName = typeof localStorage !== 'undefined' ? (localStorage.getItem('lastName') ?? '') : '';
	await xmpp.send(
		xml(
			'message',
			{
				id: `message-reaction:${Date.now()}`,
				type: 'groupchat',
				to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}`
			},
			xml(
				'reactions',
				{ id: targetId, from: `${currentUser}@${PUBLIC_XMPP_HOST}`, xmlns: 'urn:xmpp:reactions:0' },
				...codes.map((code) => xml('reaction', {}, code))
			),
			xml('data', { senderFirstName: firstName, senderLastName: lastName }),
			xml('store', { xmlns: 'urn:xmpp:hints' })
		)
	);
	// show it right away; the reflection carries a real (larger) archive id and
	// harmlessly re-applies the same set
	applyReaction(roomName, targetId, currentUser, codes, String(Date.now() * 1000));
}

export async function disconnectXmpp(): Promise<void> {
	if (xmpp) {
		try {
			await xmpp.stop();
		} catch {
			// connection may already be dead — nothing to clean up
		}
		xmpp = null;
	}
	currentUser = '';
	xmppState.status = 'offline';
	xmppState.joinedRooms = [];
	xmppState.occupants = {};
}
