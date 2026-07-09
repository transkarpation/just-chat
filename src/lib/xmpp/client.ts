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
	forgetRoom,
	type ChatMessage
} from '$lib/state/messages.svelte';

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

		// unavailable presence from the BARE room JID (no occupant nick)
		// means the owner destroyed the room — drop it everywhere locally
		if (!nick) {
			if (type === 'unavailable') removeRoomLocally(room);
			return;
		}

		// occupant roster: the server sends one available presence per occupant
		// on join, then live updates as people come and go
		if (type === 'unavailable') {
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

		// a MUC join is confirmed by a self-presence carrying status code 110
		const x = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
		const codes = x?.getChildren('status').map((s) => s.attrs.code) ?? [];
		if (codes.includes('110') && !xmppState.joinedRooms.includes(room)) {
			xmppState.joinedRooms.push(room);
		}
	});

	// live groupchat messages — including the reflection of our own sends;
	// their <stanza-id> equals the MAM archive id, so dedupe with history is free
	xmpp.on('stanza', (stanza) => {
		if (!stanza.is('message') || stanza.attrs.type !== 'groupchat') return;
		if (stanza.getChild('result', 'urn:xmpp:mam:2')) return; // MAM page, handled elsewhere
		if (stanza.getChild('delay', 'urn:xmpp:delay')) return; // join-time history replay, MAM covers it
		const body = stanza.getChildText('body');
		if (!body) return;
		const [bareJid, nick] = String(stanza.attrs.from ?? '').split('/');
		const [room, host] = (bareJid ?? '').split('@');
		if (host !== PUBLIC_XMPP_CONFERENCE || !room || !nick) return;
		appendMessage(room, {
			id:
				stanza.getChild('stanza-id', 'urn:xmpp:sid:0')?.attrs.id ??
				`live-${stanza.attrs.id ?? crypto.randomUUID()}`,
			roomName: room,
			nickname: nick,
			body,
			timestamp: new Date().toISOString(),
			...senderMeta(stanza)
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

	const notification = new Notification(chat?.title ?? 'New message', {
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
		collected.push({
			id: String(result.attrs.id),
			roomName,
			nickname: String(message.attrs.from ?? '').split('/')[1] ?? '',
			body,
			timestamp: forwarded?.getChild('delay', 'urn:xmpp:delay')?.attrs.stamp ?? '',
			...senderMeta(message)
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
 * Ethora convention: each message carries a <data> element with the sender's
 * profile at the moment of sending (names, photoURL). Read it if present.
 */
function senderMeta(message: ReturnType<typeof xml>): {
	senderName?: string;
	avatar?: string;
} {
	const data = message.getChild('data');
	if (!data) return {};
	const name = `${data.attrs.senderFirstName ?? ''} ${data.attrs.senderLastName ?? ''}`.trim();
	const avatar = data.attrs.photoURL || data.attrs.photo || undefined;
	return { senderName: name || undefined, avatar };
}

/** Remove every local trace of a room that was deleted by its owner. */
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
	const firstName = localStorage.getItem('firstName') ?? '';
	const lastName = localStorage.getItem('lastName') ?? '';
	const photoURL = localStorage.getItem('profileImage') ?? '';
	await xmpp.send(
		xml(
			'message',
			{ type: 'groupchat', to: `${roomName}@${PUBLIC_XMPP_CONFERENCE}` },
			xml('body', {}, body),
			// Ethora convention: attach the sender's profile so every client
			// (including ours) can render the name and avatar
			xml('data', {
				xmlns: PUBLIC_XMPP_WS,
				senderFirstName: firstName,
				senderLastName: lastName,
				fullName: `${firstName} ${lastName}`.trim(),
				photoURL,
				senderJID: `${currentUser}@${PUBLIC_XMPP_HOST}`,
				roomJid: `${roomName}@${PUBLIC_XMPP_CONFERENCE}`,
				isSystemMessage: 'false'
			})
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
