import { api } from './client';

export interface ChatMember {
	_id: string;
	firstName: string;
	lastName: string;
	xmppUsername: string;
	description?: string;
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
