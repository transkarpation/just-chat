export interface MessageMedia {
	location: string;
	locationPreview: string;
	mimetype: string;
	originalName: string;
	size: number;
}

/** an @-mention inside the message body (XEP-0372 reference) */
export interface MessageMention {
	/** UTF-16 index of the first char of the `@Name` token in body */
	begin: number;
	/** UTF-16 index one past the last char of the token */
	end: number;
	/** xmppUsername of the mentioned user */
	xmppUsername: string;
}

export interface ChatMessage {
	/** MAM archive id — unique and chronologically sortable */
	id: string;
	roomName: string;
	/** MUC nickname of the sender (resource part of the room JID) */
	nickname: string;
	body: string;
	/** ISO timestamp from the archive's <delay> element */
	timestamp: string;
	/** attached files — for these messages the body is either the literal
	 * "media" (no caption) or the caption text */
	media?: MessageMedia[];
	/** @-mentions of chat members inside the body */
	mentions?: MessageMention[];
	/** body was edited via a <replace> stanza (MAM marks these <replaced>) */
	edited?: boolean;
	/** reactions per reactor nick → their current set of emoji shortcodes.
	 * XEP-0444: each <reactions> stanza carries that user's FULL set, so this
	 * is a replace-per-user map, not an append log. */
	reactions?: Record<string, string[]>;
	/** archive id of the <reactions> stanza that last set each reactor's set —
	 * lets out-of-order updates (MAM paging) apply with last-writer-wins */
	reactionAt?: Record<string, string>;
	/** own message shown optimistically, before the server echoed it back;
	 * `id` is a local placeholder, not an archive id */
	pending?: boolean;
	/** nicknames whose clients confirmed receiving this message (delivery
	 * receipts); may include the own nickname for incoming messages */
	receivedBy?: string[];
}

export interface RoomMessages {
	/** oldest → newest */
	messages: ChatMessage[];
	/** archive id of the oldest loaded message — pagination cursor */
	firstArchiveId: string | null;
	/** true when the beginning of the archive has been reached */
	complete: boolean;
	loading: boolean;
	/** delivery receipts whose message is not loaded yet (receipts are always
	 * archived after their message, so newer MAM pages can reference messages
	 * from older, not-yet-loaded pages) — applied when the message arrives */
	pendingReceipts: Record<string, string[]>;
	/** reactions whose target message is not loaded yet, keyed by target id —
	 * applied when the message arrives (same reason as pendingReceipts) */
	pendingReactions: Record<string, { nick: string; codes: string[]; at: string }[]>;
	/** read watermark per nickname: the archive id of the newest message that
	 * user has displayed — every message with id <= watermark counts as read
	 * by them (XEP-0333 semantics: a marker covers everything before it) */
	displayedUpTo: Record<string, string>;
}

export const messagesState = $state({
	rooms: {} as Record<string, RoomMessages>
});

export function ensureRoom(roomName: string): RoomMessages {
	if (!messagesState.rooms[roomName]) {
		messagesState.rooms[roomName] = {
			messages: [],
			firstArchiveId: null,
			complete: false,
			loading: false,
			pendingReceipts: {},
			pendingReactions: {},
			displayedUpTo: {}
		};
	}
	return messagesState.rooms[roomName];
}

/** Add an older page of messages to the beginning of the room history. */
export function prependMessages(
	roomName: string,
	incoming: ChatMessage[],
	firstArchiveId: string | null,
	complete: boolean
): void {
	const room = ensureRoom(roomName);
	const known = new Set(room.messages.map((m) => m.id));
	const fresh = incoming.filter((m) => !known.has(m.id));
	// receipts / reactions from newer pages may have been waiting for these
	for (const message of fresh) {
		const waiting = room.pendingReceipts[message.id];
		if (waiting) {
			message.receivedBy = [...new Set([...(message.receivedBy ?? []), ...waiting])];
			delete room.pendingReceipts[message.id];
		}
		const reactions = room.pendingReactions[message.id];
		if (reactions) {
			for (const r of reactions) setMessageReaction(message, r.nick, r.codes, r.at);
			delete room.pendingReactions[message.id];
		}
	}
	room.messages = [...fresh, ...room.messages];
	if (firstArchiveId) {
		room.firstArchiveId = firstArchiveId;
	}
	room.complete = complete;
}

/**
 * Compare two MAM archive ids chronologically. They are decimal microsecond
 * timestamps, so shorter means older; equal lengths compare lexicographically.
 */
export function compareArchiveIds(a: string, b: string): number {
	return a.length !== b.length ? a.length - b.length : a.localeCompare(b);
}

/**
 * Record a read (displayed) marker: `nickname` has seen everything up to and
 * including the message with `markerId`. Only the newest watermark is kept.
 */
export function applyDisplayedMarker(
	roomName: string,
	nickname: string,
	markerId: string
): void {
	const room = ensureRoom(roomName);
	const current = room.displayedUpTo[nickname];
	if (!current || compareArchiveIds(markerId, current) > 0) {
		room.displayedUpTo[nickname] = markerId;
	}
}

/**
 * Record a delivery receipt: `nickname`'s client confirmed receiving the
 * message with the given archive id. If that message is not loaded (yet),
 * the receipt is parked and applied when an older page brings the message in.
 */
export function applyReceipt(roomName: string, messageId: string, nickname: string): void {
	const room = ensureRoom(roomName);
	const message = room.messages.find((m) => m.id === messageId);
	if (message) {
		if (!message.receivedBy?.includes(nickname)) {
			message.receivedBy = [...(message.receivedBy ?? []), nickname];
		}
		return;
	}
	const waiting = room.pendingReceipts[messageId] ?? [];
	if (!waiting.includes(nickname)) {
		room.pendingReceipts[messageId] = [...waiting, nickname];
	}
}

/** Add a freshly received live message to the end of the room history. */
export function appendMessage(roomName: string, message: ChatMessage): void {
	const room = ensureRoom(roomName);
	if (room.messages.some((m) => m.id === message.id)) return;
	room.messages = [...room.messages, message];
}

/**
 * Replace an optimistic pending message with its server-confirmed version
 * (the MUC echo carries the same stanza id we sent). Returns false when no
 * pending message with that id exists — e.g. the send happened in another
 * session — so the caller appends the echo as a regular message instead.
 */
export function confirmMessage(
	roomName: string,
	localId: string,
	confirmed: ChatMessage
): boolean {
	const room = messagesState.rooms[roomName];
	if (!room) return false;
	const index = room.messages.findIndex((m) => m.pending && m.id === localId);
	if (index === -1) return false;
	if (room.messages.some((m) => m.id === confirmed.id)) {
		// the confirmed copy is already in state — just drop the pending one
		room.messages = room.messages.filter((m) => m.id !== localId);
		return true;
	}
	room.messages = room.messages.map((m, i) => (i === index ? confirmed : m));
	return true;
}

/**
 * Set one reactor's full reaction set on a loaded message, honouring
 * last-writer-wins: an update older (by archive id) than the one already
 * applied for that reactor is ignored, so out-of-order MAM pages are safe.
 * An empty `codes` clears the reactor's reactions.
 */
function setMessageReaction(
	message: ChatMessage,
	nick: string,
	codes: string[],
	at: string
): void {
	const current = message.reactionAt?.[nick];
	if (current && compareArchiveIds(at, current) < 0) return;
	const reactions = { ...(message.reactions ?? {}) };
	if (codes.length > 0) reactions[nick] = codes;
	else delete reactions[nick];
	message.reactions = Object.keys(reactions).length > 0 ? reactions : undefined;
	message.reactionAt = { ...(message.reactionAt ?? {}), [nick]: at };
}

/**
 * Apply a reaction update (XEP-0444 <reactions> stanza). `at` is the reaction
 * stanza's own archive id (its version). If the target message is not loaded
 * yet, the update is parked and applied when the message arrives.
 */
export function applyReaction(
	roomName: string,
	targetId: string,
	nick: string,
	codes: string[],
	at: string
): void {
	const room = ensureRoom(roomName);
	const message = room.messages.find((m) => m.id === targetId);
	if (!message) {
		const waiting = room.pendingReactions[targetId] ?? [];
		waiting.push({ nick, codes, at });
		room.pendingReactions[targetId] = waiting;
		return;
	}
	setMessageReaction(message, nick, codes, at);
}

/**
 * Apply an edit (<replace> stanza): swap the message body in place. The old
 * mention ranges no longer match the new text, so they are dropped — the
 * replace convention carries no references.
 */
export function replaceMessageBody(roomName: string, messageId: string, body: string): void {
	const message = messagesState.rooms[roomName]?.messages.find((m) => m.id === messageId);
	if (!message) return;
	message.body = body;
	message.edited = true;
	message.mentions = undefined;
}

/** Drop a message that was deleted in the room. */
export function removeMessage(roomName: string, messageId: string): void {
	const room = messagesState.rooms[roomName];
	if (!room) return;
	room.messages = room.messages.filter((m) => m.id !== messageId);
}

export function lastMessage(roomName: string): ChatMessage | undefined {
	return messagesState.rooms[roomName]?.messages.at(-1);
}

export function forgetRoom(roomName: string): void {
	delete messagesState.rooms[roomName];
}

export function clearMessages(): void {
	messagesState.rooms = {};
}
