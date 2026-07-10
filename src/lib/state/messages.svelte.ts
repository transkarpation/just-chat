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
	/** attached file — the body is the literal "media" for these messages */
	media?: MessageMedia;
	/** @-mentions of chat members inside the body */
	mentions?: MessageMention[];
}

export interface RoomMessages {
	/** oldest → newest */
	messages: ChatMessage[];
	/** archive id of the oldest loaded message — pagination cursor */
	firstArchiveId: string | null;
	/** true when the beginning of the archive has been reached */
	complete: boolean;
	loading: boolean;
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
			loading: false
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
	room.messages = [...incoming.filter((m) => !known.has(m.id)), ...room.messages];
	if (firstArchiveId) {
		room.firstArchiveId = firstArchiveId;
	}
	room.complete = complete;
}

/** Add a freshly received live message to the end of the room history. */
export function appendMessage(roomName: string, message: ChatMessage): void {
	const room = ensureRoom(roomName);
	if (room.messages.some((m) => m.id === message.id)) return;
	room.messages = [...room.messages, message];
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
