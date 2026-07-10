import { api } from './client';

export interface ChatMember {
	_id: string;
	firstName: string;
	lastName: string;
	xmppUsername: string;
	description?: string;
	/** avatar URL — present when the user has set a profile photo */
	profileImage?: string;
}

export interface Chat {
	_id: string;
	name: string;
	isAppChat: boolean;
	title: string;
	description: string;
	/** only 'public' observed so far */
	type: string;
	picture: string;
	appId: string;
	createdAt: string;
	updatedAt: string;
	reported: boolean;
	/** user _id of the creator; absent on legacy/app-level chats */
	createdBy?: string;
	members: ChatMember[];
}

export interface MyChatsResponse {
	items: Chat[];
}

export async function getMyChats(): Promise<MyChatsResponse> {
	const { data } = await api.get<MyChatsResponse>('/v1/chats/my');
	return data;
}

export interface CreateChatPayload {
	title: string;
	description: string;
	picture: string;
	type: string;
	members: string[];
}

/** Unlike Chat from /chats/my, the creation result has no members/reported. */
export interface CreatedChat {
	_id: string;
	name: string;
	isAppChat: boolean;
	title: string;
	description: string;
	type: string;
	picture: string;
	createdBy: string;
	appId: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreateChatResponse {
	result: CreatedChat;
}

export interface DeleteChatResponse {
	/** name (local part of the room JID) of the deleted chat */
	result: string;
}

/**
 * Delete a chat by its room name. The backend removes it asynchronously:
 * /chats/my may keep returning the room for ~10s after a successful call.
 */
export async function deleteChat(name: string): Promise<DeleteChatResponse> {
	const { data } = await api.delete<DeleteChatResponse>('/v1/chats', { data: { name } });
	return data;
}

/** The private-chat result carries both members; `createdBy` is absent. */
export interface PrivateChat {
	_id: string;
	name: string;
	isAppChat: boolean;
	/** unreliable for private chats — derive the display title from members */
	title: string;
	description: string;
	type: string;
	picture: string;
	appId: string;
	createdAt: string;
	updatedAt: string;
	members: ChatMember[];
}

export interface CreatePrivateChatResponse {
	result: PrivateChat;
}

/**
 * Start a 1-1 chat with the given user (`xmppUsername`). Idempotent: if a
 * private chat between the two users already exists, that one is returned.
 * The chat shows up in /chats/my of both users.
 */
export async function createPrivateChat(xmppUsername: string): Promise<CreatePrivateChatResponse> {
	const { data } = await api.post<CreatePrivateChatResponse>('/v1/chats/private', {
		username: xmppUsername
	});
	return data;
}

/** response of POST/DELETE /v2/chats/users-access */
export interface UsersAccessResponse {
	ok: boolean;
	summary: { requested: number; byStatus: Record<string, number> };
	details: { xmppUsername: string; status: string }[];
}

/**
 * Add users to a chat (owner-scoped). `members` takes xmppUsernames.
 * The new membership shows up in /chats/my of both sides immediately.
 */
export async function addChatMembers(
	chatName: string,
	members: string[]
): Promise<UsersAccessResponse> {
	const { data } = await api.post<UsersAccessResponse>('/v2/chats/users-access', {
		chatName,
		members
	});
	return data;
}

/**
 * Remove users from a chat (owner-scoped). `members` takes xmppUsernames.
 * The backend drops the membership asynchronously — /chats/my keeps showing
 * the member for ~45s after a successful call, so update local state instead
 * of refetching. Removing YOURSELF this way fails with CHAT_NOT_FOUND —
 * self-leave only works via the XMPP MUC/Sub unsubscribe (see leaveRoom).
 */
export async function removeChatMembers(
	chatName: string,
	members: string[]
): Promise<UsersAccessResponse> {
	const { data } = await api.delete<UsersAccessResponse>('/v2/chats/users-access', {
		data: { chatName, members }
	});
	return data;
}

export async function createChat(
	input: { title: string } & Partial<Omit<CreateChatPayload, 'title'>>
): Promise<CreateChatResponse> {
	const payload: CreateChatPayload = {
		description: 'No description',
		picture: '',
		type: 'public',
		members: [],
		...input
	};
	const { data } = await api.post<CreateChatResponse>('/v1/chats', payload);
	return data;
}
