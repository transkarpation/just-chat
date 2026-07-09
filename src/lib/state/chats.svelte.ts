import type { Chat } from '$lib/api/chats';

export const chatsState = $state({
	items: [] as Chat[],
	loaded: false
});

export function setChats(items: Chat[]) {
	chatsState.items = items;
	chatsState.loaded = true;
}

export function clearChats() {
	chatsState.items = [];
	chatsState.loaded = false;
}
