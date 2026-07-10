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
	ensureRoom,
	prependMessages,
	appendMessage,
	removeMessage,
	forgetRoom,
	type ChatMessage,
	type MessageMedia
} from '$lib/state/messages.svelte';
import type { UploadedFile } from '$lib/api/files';

let xmpp: Client | null = null;
let currentUser = '';
let mamQueryCounter = 0;
const handledInvites = new Set<string>();

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
		const body = stanza.getChildText('body');
		if (!body) return;
		appendMessage(room, {
			id:
				stanza.getChild('stanza-id', 'urn:xmpp:sid:0')?.attrs.id ??
				`live-${stanza.attrs.id ?? crypto.randomUUID()}`,
			roomName: room,
			nickname: nick,
			body,
			timestamp: new Date().toISOString(),
			media: mediaMeta(stanza)
		});
		notifyIfBackgrounded(room, nick, body);
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
function notifyIfBackgrounded(roomName: string, nickname: string, body: string): void {
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
	const title = (chat?.type === 'private' ? sender : chat?.title) || 'New message';
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

	// archived messages arrive as separate stanzas correlated by queryid,
	// while the awaited IQ result only carries the paging metadata
	const onStanza = (stanza: ReturnType<typeof xml>) => {
		if (!stanza.is('message')) return;
		const result = stanza.getChild('result', 'urn:xmpp:mam:2');
		if (!result || result.attrs.queryid !== queryid) return;
		const forwarded = result.getChild('forwarded', 'urn:xmpp:forward:0');
		const message = forwarded?.getChild('message');
		const body = message?.getChildText('body');
		if (!message || !body) return; // skip bodyless archive entries
		// deleted messages stay in the archive as tombstones: the body
		// becomes "deleted" and a <deleted> element is attached
		if (message.getChild('deleted')) return;
		collected.push({
			id: String(result.attrs.id),
			roomName,
			nickname: String(message.attrs.from ?? '').split('/')[1] ?? '',
			body,
			timestamp: forwarded?.getChild('delay', 'urn:xmpp:delay')?.attrs.stamp ?? '',
			media: mediaMeta(message)
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
			first: set?.getChildText('first') ?? null,
			complete: fin?.attrs.complete === 'true'
		};
	} finally {
		connection.off('stanza', onStanza);
	}
}

/** Fetch the newest message of each room that has no history in state yet. */
export async function loadLastMessages(roomNames: string[]): Promise<void> {
	await Promise.all(
		roomNames.map(async (roomName) => {
			if (ensureRoom(roomName).messages.length > 0) return;
			const page = await fetchRoomHistory(roomName, { max: 1 });
			prependMessages(roomName, page.messages, page.first, page.complete);
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
 * Ethora convention for attachments: the message body is the literal "media"
 * and the file metadata travels in a <data isMediafile="true"> element.
 */
function mediaMeta(message: ReturnType<typeof xml>): MessageMedia | undefined {
	const data = message.getChild('data');
	if (data?.attrs.isMediafile !== 'true' || !data.attrs.location) return undefined;
	return {
		location: String(data.attrs.location),
		locationPreview: String(data.attrs.locationPreview || data.attrs.location),
		mimetype: String(data.attrs.mimetype ?? ''),
		originalName: String(data.attrs.originalName ?? ''),
		size: Number(data.attrs.size) || 0
	};
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

/** Send a text message to a room. It appears in state via the MUC reflection. */
export async function sendRoomMessage(roomName: string, body: string): Promise<void> {
	if (!xmpp || xmppState.status !== 'online') {
		throw new Error('XMPP is not connected');
	}
	await xmpp.send(
		xml(
			'message',
			{ type: 'groupchat', to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}` },
			xml('body', {}, body)
		)
	);
}

/**
 * Send an already-uploaded file (POST /v1/files/) to a room. The stanza
 * follows the Ethora media format: body "media", a store hint so the server
 * archives it, and the file metadata in a <data isMediafile="true"> element.
 */
export async function sendMediaMessage(roomName: string, file: UploadedFile): Promise<void> {
	if (!xmpp || xmppState.status !== 'online') {
		throw new Error('XMPP is not connected');
	}
	await xmpp.send(
		xml(
			'message',
			{
				id: `send-media-message:${crypto.randomUUID()}`,
				type: 'groupchat',
				to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}`
			},
			xml('body', {}, 'media'),
			xml('store', { xmlns: 'urn:xmpp:hints' }),
			xml('data', {
				senderJID: `${currentUser}@${PUBLIC_XMPP_HOST}`,
				senderFirstName: localStorage.getItem('firstName') ?? '',
				senderLastName: localStorage.getItem('lastName') ?? '',
				senderWalletAddress: file.ownerKey,
				isSystemMessage: 'false',
				tokenAmount: '0',
				receiverMessageId: '0',
				photoURL: localStorage.getItem('profileImage') ?? '',
				isMediafile: 'true',
				createdAt: file.createdAt,
				expiresAt: String(file.expiresAt),
				fileName: file.filename,
				location: file.location,
				locationPreview: file.locationPreview,
				mimetype: file.mimetype,
				originalName: file.originalname,
				ownerKey: file.ownerKey,
				size: String(file.size),
				updatedAt: file.updatedAt,
				userId: file.userId,
				attachmentId: file._id,
				isReply: 'false',
				showInChannel: 'false',
				mainMessage: '',
				roomJid: `${roomName}@${PUBLIC_XMPP_CONFERENCE}`,
				push: 'true'
			})
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
	// also end the occupant session in the room
	await xmpp.send(
		xml('presence', {
			to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}/${currentUser}`,
			type: 'unavailable'
		})
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
