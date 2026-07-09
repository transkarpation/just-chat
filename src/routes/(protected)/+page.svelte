<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Dialog, Tabs } from 'bits-ui';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import {
		getMyChats,
		createChat,
		deleteChat,
		type Chat,
		type ChatMember
	} from '$lib/api/chats';
	import { getApiErrorMessage } from '$lib/api/auth';
	import { chatsState, setChats, clearChats } from '$lib/state/chats.svelte';
	import { xmppState } from '$lib/state/xmpp.svelte';
	import {
		messagesState,
		lastMessage,
		clearMessages,
		forgetRoom,
		type ChatMessage
	} from '$lib/state/messages.svelte';
	import {
		connectAndJoinRooms,
		disconnectXmpp,
		loadLastMessages,
		loadOlderMessages,
		sendRoomMessage,
		subscribeToRoom
	} from '$lib/xmpp/client';

	let loading = $state(false);
	let error = $state('');
	let selectedRoom = $state<string | null>(null);
	let myNickname = $state('');
	let myUserId = $state('');
	let userEmail = $state('');
	let notifPermission = $state<NotificationPermission | 'unsupported' | null>(null);
	let notifBannerDismissed = $state(false);
	let messagesEl = $state<HTMLElement | null>(null);
	let composerEl = $state<HTMLInputElement | null>(null);
	let showOnlineList = $state(false);
	let draft = $state('');
	let sending = $state(false);
	let sendError = $state('');
	let showNewChat = $state(false);
	let newChatTitle = $state('');
	let newChatType = $state<'public' | 'group'>('public');
	let newChatMembers = $state<string[]>([]);
	let creatingChat = $state(false);
	let createError = $state('');

	// everyone seen across the members of my chats, deduped by xmppUsername —
	// the identifier the create-chat endpoint expects in `members`
	const memberCandidates = $derived.by(() => {
		const seen = new Map<string, ChatMember>();
		for (const chat of chatsState.items) {
			for (const member of chat.members) {
				if (member.xmppUsername === myNickname) continue;
				if (!seen.has(member.xmppUsername)) seen.set(member.xmppUsername, member);
			}
		}
		return [...seen.values()].sort((a, b) =>
			`${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)
		);
	});

	let memberTab = $state('all');

	// someone is online if their nickname is present in any room's occupants
	const onlineNicknames = $derived.by(() => {
		const nicknames = new Set<string>();
		for (const roomOccupants of Object.values(xmppState.occupants)) {
			for (const nickname of roomOccupants) nicknames.add(nickname);
		}
		return nicknames;
	});
	const onlineCandidates = $derived(
		memberCandidates.filter((m) => onlineNicknames.has(m.xmppUsername))
	);
	const visibleCandidates = $derived(
		memberTab === 'online'
			? onlineCandidates
			: memberTab === 'selected'
				? memberCandidates.filter((m) => newChatMembers.includes(m.xmppUsername))
				: memberCandidates
	);

	const selectedChat = $derived(
		chatsState.items.find((chat) => chat.name === selectedRoom) ?? null
	);
	// freshest conversation first; chats with no known messages sink to the
	// bottom. Reacts to live messages too, so an active chat bubbles up.
	const sortedChats = $derived(
		[...chatsState.items].sort((a, b) => {
			const aTime = Date.parse(lastMessage(a.name)?.timestamp ?? '') || 0;
			const bTime = Date.parse(lastMessage(b.name)?.timestamp ?? '') || 0;
			return bTime - aTime;
		})
	);
	const selectedMessages = $derived(
		selectedRoom ? (messagesState.rooms[selectedRoom] ?? null) : null
	);

	onMount(async () => {
		// state is in-memory only, so after a page reload it is empty
		// even though the user is still logged in — refetch in that case
		if (!chatsState.loaded) {
			loading = true;
			try {
				const chats = await getMyChats();
				setChats(chats.items);
			} catch (err) {
				error = getApiErrorMessage(err);
			} finally {
				loading = false;
			}
		}

		const xmppUsername = localStorage.getItem('xmppUsername');
		const xmppPassword = localStorage.getItem('xmppPassword');
		myNickname = xmppUsername ?? '';
		// sessions from before userId was stored: derive it from the
		// xmppUsername, which is `${appId}_${userId}`
		myUserId = localStorage.getItem('userId') ?? myNickname.split('_')[1] ?? '';
		userEmail = localStorage.getItem('userEmail') ?? '';
		notifPermission = 'Notification' in window ? Notification.permission : 'unsupported';
		if (xmppUsername && xmppPassword && chatsState.items.length > 0) {
			try {
				const roomNames = chatsState.items.map((chat) => chat.name);
				await connectAndJoinRooms(xmppUsername, xmppPassword, roomNames);
				await loadLastMessages(roomNames);
			} catch (err) {
				console.error('XMPP setup failed:', err);
			}
		}
	});

	// jump to the newest message when one is appended to the open chat
	// (own send reflection or someone else's live message); prepending
	// older pages keeps the newest id unchanged and doesn't trigger this
	let prevNewestId: string | null = null;
	$effect(() => {
		const newestId = selectedMessages?.messages.at(-1)?.id ?? null;
		if (newestId && prevNewestId && newestId !== prevNewestId) {
			scrollToBottom();
		}
		prevNewestId = newestId;
	});

	async function scrollToBottom() {
		await tick(); // let the message list render first
		if (messagesEl) {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		}
	}

	// the URL query is the source of truth for the active room: clicking a
	// chat only navigates, and this effect reacts to any change of ?roomId —
	// clicks, back/forward buttons, or a deep link opened after reload.
	// A roomId the user is not a member of yet (a link shared by someone
	// else) triggers a join attempt once the XMPP connection is up.
	const attemptedJoins = new Set<string>();
	$effect(() => {
		const roomId = page.url.searchParams.get('roomId');
		if (!chatsState.loaded) return;
		if (!roomId) {
			selectedRoom = null;
			return;
		}
		if (roomId === selectedRoom) return;
		if (chatsState.items.some((chat) => chat.name === roomId)) {
			activateRoom(roomId);
		} else if (xmppState.status === 'online' && !attemptedJoins.has(roomId)) {
			attemptedJoins.add(roomId);
			joinRoomFromLink(roomId);
		}
	});

	let joiningRoom = $state<string | null>(null);
	let joinError = $state('');

	async function joinRoomFromLink(roomName: string) {
		joiningRoom = roomName;
		joinError = '';
		try {
			const xmppUsername = localStorage.getItem('xmppUsername');
			const xmppPassword = localStorage.getItem('xmppPassword');
			if (!xmppUsername || !xmppPassword) {
				throw new Error('XMPP credentials are missing');
			}
			await subscribeToRoom(roomName, xmppUsername);
			// join presence right away — the backend needs it too
			await connectAndJoinRooms(xmppUsername, xmppPassword, [
				...chatsState.items.map((chat) => chat.name),
				roomName
			]);
			// the backend registers the membership asynchronously (~10s
			// observed), so poll /chats/my until the room shows up there
			const appeared = await waitForRoomInMyChats(roomName, 30_000);
			if (!appeared) {
				throw new Error('room did not appear in the chat list in time');
			}
			await loadLastMessages(chatsState.items.map((chat) => chat.name));
			// chatsState.items now contains the room, so the effect above
			// re-runs and activates it
		} catch (err) {
			console.error('joining room from link failed:', err);
			joinError = 'Could not join this room.';
			attemptedJoins.delete(roomName); // allow retrying
		} finally {
			joiningRoom = null;
		}
	}

	async function waitForRoomInMyChats(roomName: string, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const chats = await getMyChats();
			setChats(chats.items);
			if (chats.items.some((chat) => chat.name === roomName)) return true;
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}

	function retryJoin() {
		const roomId = page.url.searchParams.get('roomId');
		if (roomId) {
			attemptedJoins.add(roomId);
			joinRoomFromLink(roomId);
		}
	}

	async function selectChat(roomName: string) {
		if (selectedRoom === roomName) return;
		await goto(`?roomId=${encodeURIComponent(roomName)}`, {
			keepFocus: true,
			noScroll: true
		});
	}

	async function activateRoom(roomName: string) {
		selectedRoom = roomName;
		showOnlineList = false;
		sendError = '';
		joinError = '';
		deleteError = '';
		prevNewestId = null;
		// history already in state (chat was opened before) — jump right away
		await scrollToBottom();
		composerEl?.focus();
		try {
			await loadOlderMessages(roomName, 20);
		} catch (err) {
			console.error('history load failed:', err);
			return;
		}
		// the first page just arrived; keep the newest messages in view
		// unless the user has already switched to another chat
		if (selectedRoom === roomName) {
			await scrollToBottom();
		}
	}

	function nickToName(chat: Chat, nickname: string): string {
		if (nickname === myNickname) return 'You';
		const member = chat.members.find((m) => m.xmppUsername === nickname);
		if (member) return `${member.firstName} ${member.lastName}`.trim();
		// unknown occupant — show a short readable piece of the nickname
		return nickname.split('_')[1]?.slice(0, 8) ?? nickname;
	}

	function senderName(chat: Chat, message: ChatMessage): string {
		if (message.nickname === myNickname) return 'You';
		const member = chat.members.find((m) => m.xmppUsername === message.nickname);
		if (member) return `${member.firstName} ${member.lastName}`.trim();
		// not in the member list — use the name the message itself carried
		return message.senderName ?? nickToName(chat, message.nickname);
	}

	type BodyPart =
		| { type: 'text'; value: string }
		| { type: 'link'; value: string; href: string; internal: boolean };

	// split a message into text and link segments; links to this app's own
	// origin become relative hrefs (handled by the SvelteKit router in-place),
	// everything else opens in a new tab
	function linkify(body: string): BodyPart[] {
		const parts: BodyPart[] = [];
		let lastIndex = 0;
		for (const match of body.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) {
			// don't swallow trailing punctuation like "look: https://a.com."
			const url = match[0].replace(/[.,!?;:]+$/, '');
			if (match.index > lastIndex) {
				parts.push({ type: 'text', value: body.slice(lastIndex, match.index) });
			}
			let href = url;
			let internal = false;
			try {
				const parsed = new URL(url);
				const roomId = parsed.searchParams.get('roomId');
				const isAppHost =
					parsed.origin === location.origin ||
					parsed.hostname === 'localhost' ||
					parsed.hostname === '127.0.0.1';
				if (roomId && isAppHost) {
					// a room link: navigate in place so the ?roomId effect
					// either opens the room or joins the user into it first
					internal = true;
					href = `/?roomId=${encodeURIComponent(roomId)}`;
				} else if (parsed.origin === location.origin) {
					internal = true;
					href = parsed.pathname + parsed.search + parsed.hash;
				}
			} catch {
				// leave the malformed URL as an external link as-is
			}
			parts.push({ type: 'link', value: url, href, internal });
			lastIndex = match.index + url.length;
		}
		if (lastIndex < body.length) {
			parts.push({ type: 'text', value: body.slice(lastIndex) });
		}
		return parts;
	}

	function formatTime(timestamp: string): string {
		if (!timestamp) return '';
		return new Date(timestamp).toLocaleString();
	}

	async function createNewChat() {
		const title = newChatTitle.trim();
		if (!title || creatingChat) return;
		creatingChat = true;
		createError = '';
		try {
			const created = await createChat({
				title,
				type: newChatType,
				members: newChatMembers
			});
			// refetch so the new chat has the canonical /chats/my shape
			const chats = await getMyChats();
			setChats(chats.items);

			const xmppUsername = localStorage.getItem('xmppUsername');
			const xmppPassword = localStorage.getItem('xmppPassword');
			if (xmppUsername && xmppPassword) {
				const roomNames = chatsState.items.map((chat) => chat.name);
				await connectAndJoinRooms(xmppUsername, xmppPassword, roomNames);
				await loadLastMessages(roomNames);
			}

			newChatTitle = '';
			newChatType = 'public';
			newChatMembers = [];
			showNewChat = false;
			await selectChat(created.result.name);
		} catch (err) {
			createError = getApiErrorMessage(err);
		} finally {
			creatingChat = false;
		}
	}

	let deletingChat = $state(false);
	let deleteError = $state('');
	let confirmDeleteOpen = $state(false);

	async function deleteCurrentChat() {
		if (!selectedChat || deletingChat) return;
		deletingChat = true;
		deleteError = '';
		const name = selectedChat.name;
		try {
			await deleteChat(name);
			// the backend deletes asynchronously (~10s), so a refetch would
			// resurrect the room — drop it from local state ourselves
			setChats(chatsState.items.filter((chat) => chat.name !== name));
			forgetRoom(name);
			xmppState.joinedRooms = xmppState.joinedRooms.filter((room) => room !== name);
			delete xmppState.occupants[name];
			await goto('/');
		} catch (err) {
			deleteError = getApiErrorMessage(err);
		} finally {
			deletingChat = false;
		}
	}

	let linkCopied = $state(false);
	async function copyRoomLink() {
		if (!selectedChat) return;
		const link = `${location.origin}/?roomId=${encodeURIComponent(selectedChat.name)}`;
		await navigator.clipboard.writeText(link);
		linkCopied = true;
		setTimeout(() => (linkCopied = false), 2000);
	}

	async function sendMessage() {
		const text = draft.trim();
		if (!text || !selectedRoom || sending) return;
		sending = true;
		sendError = '';
		try {
			await sendRoomMessage(selectedRoom, text);
			draft = '';
		} catch (err) {
			console.error('send failed:', err);
			sendError = 'Failed to send the message. Check the connection and try again.';
		} finally {
			sending = false;
		}
	}

	async function enableNotifications() {
		// the prompt must be triggered by a user gesture, otherwise
		// browsers ignore it or auto-block the origin
		notifPermission = await Notification.requestPermission();
	}

	function logout() {
		disconnectXmpp();
		localStorage.removeItem('token');
		localStorage.removeItem('refreshToken');
		localStorage.removeItem('xmppUsername');
		localStorage.removeItem('xmppPassword');
		localStorage.removeItem('userEmail');
		localStorage.removeItem('userId');
		localStorage.removeItem('firstName');
		localStorage.removeItem('lastName');
		localStorage.removeItem('profileImage');
		localStorage.removeItem('description');
		clearChats();
		clearMessages();
		goto('/login');
	}
</script>

<svelte:head>
	<title>User page</title>
</svelte:head>

<div class="flex h-screen flex-col bg-gray-50">
	<header class="shrink-0 border-b border-gray-200 bg-white">
		<div class="flex items-center justify-between px-4 py-3 sm:px-6">
			<h1 class="text-lg font-semibold text-gray-900">User page</h1>
			<div class="flex items-center gap-4">
				<span class="flex items-center gap-1.5 text-sm text-gray-500">
					<span
						class="h-2 w-2 rounded-full {xmppState.status === 'online'
							? 'bg-green-500'
							: 'bg-gray-300'}"
					></span>
					XMPP {xmppState.status}
				</span>
				<a
					href="/profile"
					class="text-sm font-medium text-gray-700 hover:text-indigo-600"
					title="Open profile"
				>
					{#if userEmail}
						<span class="hidden sm:inline">{userEmail}</span>
						<span class="sm:hidden">Profile</span>
					{:else}
						Profile
					{/if}
				</a>
				<button
					type="button"
					onclick={logout}
					class="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
				>
					Log out
				</button>
			</div>
		</div>
	</header>

	{#if !notifBannerDismissed && notifPermission === 'default'}
		<div class="flex shrink-0 items-center justify-between gap-4 border-b border-indigo-100 bg-indigo-50 px-4 py-2.5 sm:px-6">
			<p class="text-sm text-indigo-900">
				Enable browser notifications to know when new messages arrive.
			</p>
			<div class="flex shrink-0 items-center gap-2">
				<button
					type="button"
					onclick={enableNotifications}
					class="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
				>
					Enable notifications
				</button>
				<button
					type="button"
					onclick={() => (notifBannerDismissed = true)}
					aria-label="Dismiss"
					class="rounded-md px-2 py-1 text-sm text-indigo-400 hover:bg-indigo-100 hover:text-indigo-600"
				>
					✕
				</button>
			</div>
		</div>
	{:else if !notifBannerDismissed && notifPermission === 'denied'}
		<div class="flex shrink-0 items-center justify-between gap-4 border-b border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-6">
			<p class="text-sm text-amber-900">
				Notifications are blocked for this site. You won't be alerted about new messages —
				to change this, allow notifications in your browser's site settings (the icon next
				to the address bar).
			</p>
			<button
				type="button"
				onclick={() => (notifBannerDismissed = true)}
				aria-label="Dismiss"
				class="shrink-0 rounded-md px-2 py-1 text-sm text-amber-500 hover:bg-amber-100 hover:text-amber-700"
			>
				✕
			</button>
		</div>
	{/if}

	<div class="flex min-h-0 flex-1">
		<!-- chat list -->
		<aside class="flex w-80 shrink-0 flex-col border-r border-gray-200 bg-white">
			<div class="flex items-center justify-between border-b border-gray-100 px-4 py-3">
				<h2 class="text-sm font-semibold text-gray-900">My chats</h2>
				<div class="flex items-center gap-2">
					{#if chatsState.loaded}
						<span class="text-xs text-gray-500">{chatsState.items.length} total</span>
					{/if}
					<button
						type="button"
						onclick={() => {
							createError = '';
							memberTab = 'all';
							showNewChat = true;
						}}
						class="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
					>
						+ New
					</button>
				</div>
			</div>

			<div class="min-h-0 flex-1 overflow-y-auto">
				{#if loading}
					<p class="p-4 text-sm text-gray-500">Loading chats…</p>
				{:else if error}
					<p class="p-4 text-sm text-red-700" role="alert">{error}</p>
				{:else if chatsState.items.length === 0}
					<p class="p-4 text-sm text-gray-500">You have no chats yet.</p>
				{:else}
					<ul class="divide-y divide-gray-100">
						{#each sortedChats as chat (chat._id)}
							{@const last = lastMessage(chat.name)}
							{@const selected = selectedRoom === chat.name}
							<li>
								<button
									type="button"
									onclick={() => selectChat(chat.name)}
									class="flex w-full items-center gap-3 px-4 py-3 text-left {selected
										? 'bg-indigo-50'
										: 'hover:bg-gray-50'}"
								>
									{#if chat.picture}
										<img
											src={chat.picture}
											alt=""
											class="h-10 w-10 shrink-0 rounded-full object-cover"
										/>
									{:else}
										<div
											class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700"
										>
											{chat.title.charAt(0).toUpperCase()}
										</div>
									{/if}

									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-1.5">
											<p class="truncate text-sm font-medium text-gray-900">{chat.title}</p>
											{#if chat.createdBy && chat.createdBy === myUserId}
												<span
													class="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700"
												>
													yours
												</span>
											{/if}
											{#if xmppState.joinedRooms.includes(chat.name)}
												<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"></span>
											{/if}
										</div>
										{#if last}
											<p class="truncate text-xs text-gray-500">
												<span class="font-medium">{senderName(chat, last)}:</span>
												{last.body}
											</p>
										{:else if chat.description}
											<p class="truncate text-xs text-gray-500">{chat.description}</p>
										{/if}
									</div>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</aside>

		<!-- message area -->
		<section class="flex min-h-0 flex-1 flex-col">
			{#if selectedChat}
				<div
					class="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 py-3 sm:px-6"
				>
					<div class="relative min-w-0">
						<h3 class="truncate font-semibold text-gray-900">{selectedChat.title}</h3>
						<p class="text-xs text-gray-500">
							{selectedChat.members.length}
							{selectedChat.members.length === 1 ? 'member' : 'members'}
							<span class="mx-1">·</span>
							<button
								type="button"
								onclick={() => (showOnlineList = !showOnlineList)}
								class="font-medium text-green-600 underline-offset-2 hover:underline"
								aria-expanded={showOnlineList}
							>
								{xmppState.occupants[selectedChat.name]?.length ?? 0} online
							</button>
						</p>

						{#if showOnlineList}
							<!-- click-away backdrop -->
							<button
								type="button"
								class="fixed inset-0 z-10 cursor-default"
								aria-label="Close online users list"
								onclick={() => (showOnlineList = false)}
							></button>
							<div
								class="absolute top-full left-0 z-20 mt-1 max-h-64 w-64 overflow-y-auto rounded-lg bg-white py-1 shadow-lg ring-1 ring-gray-200"
							>
								{#each xmppState.occupants[selectedChat.name] ?? [] as nickname (nickname)}
									<div class="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-800">
										<span class="h-2 w-2 shrink-0 rounded-full bg-green-500"></span>
										<span class="truncate">{nickToName(selectedChat, nickname)}</span>
									</div>
								{:else}
									<p class="px-3 py-2 text-sm text-gray-500">Nobody is online.</p>
								{/each}
							</div>
						{/if}
					</div>
					<div class="flex shrink-0 items-center gap-2">
						{#if selectedChat.createdBy && selectedChat.createdBy === myUserId}
							<span
								class="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700"
							>
								created by you
							</span>
							<button
								type="button"
								onclick={() => (confirmDeleteOpen = true)}
								disabled={deletingChat}
								class="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-50 disabled:opacity-50"
							>
								{deletingChat ? 'Deleting…' : 'Delete'}
							</button>
						{/if}
						<button
							type="button"
							onclick={copyRoomLink}
							class="rounded-md bg-white px-2.5 py-1 text-xs font-medium {linkCopied
								? 'text-green-600 ring-green-300'
								: 'text-gray-700 ring-gray-300 hover:bg-gray-50'} ring-1 ring-inset"
						>
							{linkCopied ? 'Copied!' : 'Copy link'}
						</button>
						{#if xmppState.joinedRooms.includes(selectedChat.name)}
							<span
								class="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700"
							>
								joined
							</span>
						{/if}
						<span
							class="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600"
						>
							{selectedChat.type}
						</span>
					</div>
				</div>

				{#if deleteError}
					<div class="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 sm:px-6" role="alert">
						{deleteError}
					</div>
				{/if}

				<div bind:this={messagesEl} class="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
					{#if selectedMessages && !selectedMessages.complete}
						<div class="mb-4 text-center">
							<button
								type="button"
								onclick={() => selectedRoom && loadOlderMessages(selectedRoom, 20)}
								disabled={selectedMessages.loading}
								class="rounded-md bg-white px-3 py-1 text-xs font-medium text-indigo-600 ring-1 ring-inset ring-gray-200 hover:bg-indigo-50 disabled:opacity-50"
							>
								{selectedMessages.loading ? 'Loading…' : 'Load older messages'}
							</button>
						</div>
					{/if}

					{#if !selectedMessages || selectedMessages.messages.length === 0}
						<p class="py-10 text-center text-sm text-gray-500">
							{selectedMessages?.loading ? 'Loading messages…' : 'No messages in this chat yet.'}
						</p>
					{:else}
						<ul class="space-y-4">
							{#each selectedMessages.messages as message (message.id)}
								{@const mine = message.nickname === myNickname}
								<li class="flex items-end gap-2 {mine ? 'justify-end' : 'justify-start'}">
									{#if !mine}
										{#if message.avatar}
											<img
												src={message.avatar}
												alt=""
												class="h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-gray-200"
											/>
										{:else}
											<div
												class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600"
											>
												{senderName(selectedChat, message).charAt(0).toUpperCase()}
											</div>
										{/if}
									{/if}
									<div
										class="max-w-[75%] rounded-2xl px-4 py-2 {mine
											? 'rounded-br-sm bg-indigo-600 text-white'
											: 'rounded-bl-sm bg-white text-gray-900 ring-1 ring-gray-200'}"
									>
										<div class="flex items-baseline gap-2">
											<span
												class="text-xs font-semibold {mine ? 'text-indigo-100' : 'text-indigo-600'}"
											>
												{senderName(selectedChat, message)}
											</span>
											<span class="text-[10px] {mine ? 'text-indigo-200' : 'text-gray-400'}">
												{formatTime(message.timestamp)}
											</span>
										</div>
										<p class="text-sm whitespace-pre-wrap">
											{#each linkify(message.body) as part, i (i)}
												{#if part.type === 'link'}
													<a
														href={part.href}
														target={part.internal ? undefined : '_blank'}
														rel={part.internal ? undefined : 'noopener noreferrer'}
														class="font-medium underline underline-offset-2 {mine
															? 'text-white hover:text-indigo-100'
															: 'text-indigo-600 hover:text-indigo-500'}"
													>{part.value}</a>
												{:else}
													{part.value}
												{/if}
											{/each}
										</p>
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<form
					class="shrink-0 border-t border-gray-200 bg-white px-4 py-3 sm:px-6"
					onsubmit={(event) => {
						event.preventDefault();
						sendMessage();
					}}
				>
					{#if sendError}
						<p class="mb-2 text-xs text-red-600" role="alert">{sendError}</p>
					{/if}
					<div class="flex gap-2">
						<input
							type="text"
							bind:this={composerEl}
							bind:value={draft}
							placeholder={xmppState.status === 'online'
								? 'Type a message…'
								: 'Connecting…'}
							disabled={xmppState.status !== 'online'}
							class="block w-full rounded-md border-0 px-3 py-2 text-sm text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 disabled:bg-gray-50"
						/>
						<button
							type="submit"
							disabled={!draft.trim() || sending || xmppState.status !== 'online'}
							class="shrink-0 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{sending ? 'Sending…' : 'Send'}
						</button>
					</div>
				</form>
			{:else}
				<div class="flex flex-1 items-center justify-center">
					<div class="text-center">
						{#if joiningRoom}
							<p class="text-lg font-medium text-gray-900">Joining room…</p>
							<p class="mt-1 text-sm text-gray-500">
								Adding you as a member. This can take a few seconds.
							</p>
						{:else if joinError}
							<p class="text-lg font-medium text-red-700">{joinError}</p>
							<button
								type="button"
								onclick={retryJoin}
								class="mt-3 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
							>
								Try again
							</button>
						{:else}
							<p class="text-lg font-medium text-gray-900">Select a chat</p>
							<p class="mt-1 text-sm text-gray-500">
								Choose a conversation from the list to see its messages.
							</p>
						{/if}
					</div>
				</div>
			{/if}
		</section>
	</div>
</div>

<ConfirmDialog
	bind:open={confirmDeleteOpen}
	title={`Delete "${selectedChat?.title ?? ''}"?`}
	description="The room and its message history will be removed for all members. This cannot be undone."
	confirmLabel="Delete"
	destructive
	onconfirm={deleteCurrentChat}
/>

<Dialog.Root bind:open={showNewChat}>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-40 bg-gray-900/40" />
		<Dialog.Content
			class="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
		>
			<Dialog.Title class="text-base font-semibold text-gray-900">Create a new chat</Dialog.Title>

			<form
				class="mt-4"
				onsubmit={(event) => {
					event.preventDefault();
					createNewChat();
				}}
			>
				{#if createError}
					<p class="mb-2 text-xs text-red-600" role="alert">{createError}</p>
				{/if}
				<input
					type="text"
					bind:value={newChatTitle}
					placeholder="Chat title"
					class="block w-full rounded-md border-0 px-3 py-2 text-sm text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600"
				/>

				<!-- min-w-0 overrides the fieldset default min-width: min-content,
				     which otherwise lets long member names blow out the dialog width -->
				<fieldset class="mt-4 min-w-0">
					<legend class="text-xs font-medium text-gray-700">Chat type</legend>
					<div class="mt-1.5 grid grid-cols-2 gap-2">
						<label
							class="cursor-pointer rounded-lg p-3 ring-1 ring-inset {newChatType === 'public'
								? 'bg-indigo-50 ring-indigo-600'
								: 'ring-gray-300 hover:bg-gray-50'}"
						>
							<input type="radio" bind:group={newChatType} value="public" class="sr-only" />
							<span class="block text-sm font-medium text-gray-900">Public</span>
							<span class="mt-0.5 block text-xs text-gray-500">
								Anyone in the app can join via a link.
							</span>
						</label>
						<label
							class="cursor-pointer rounded-lg p-3 ring-1 ring-inset {newChatType === 'group'
								? 'bg-indigo-50 ring-indigo-600'
								: 'ring-gray-300 hover:bg-gray-50'}"
						>
							<input type="radio" bind:group={newChatType} value="group" class="sr-only" />
							<span class="block text-sm font-medium text-gray-900">Group</span>
							<span class="mt-0.5 block text-xs text-gray-500">
								A chat for you and the selected members.
							</span>
						</label>
					</div>
				</fieldset>

				<fieldset class="mt-4 min-w-0">
					<legend class="text-xs font-medium text-gray-700">Members</legend>
					<Tabs.Root bind:value={memberTab}>
						<Tabs.List class="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1">
							<Tabs.Trigger
								value="all"
								class="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900 data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=active]:shadow-sm"
							>
								All ({memberCandidates.length})
							</Tabs.Trigger>
							<Tabs.Trigger
								value="online"
								class="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900 data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=active]:shadow-sm"
							>
								Online ({onlineCandidates.length})
							</Tabs.Trigger>
							<Tabs.Trigger
								value="selected"
								class="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900 data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=active]:shadow-sm"
							>
								Selected ({newChatMembers.length})
							</Tabs.Trigger>
						</Tabs.List>
					</Tabs.Root>
					<div
						class="mt-1.5 max-h-44 divide-y divide-gray-100 overflow-y-auto rounded-md ring-1 ring-inset ring-gray-200"
					>
						{#each visibleCandidates as member (member.xmppUsername)}
							<label
								class="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-gray-50"
							>
								<input
									type="checkbox"
									bind:group={newChatMembers}
									value={member.xmppUsername}
									class="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600"
								/>
								<span class="min-w-0 flex-1 truncate text-gray-900">
									{`${member.firstName} ${member.lastName}`.trim()}
								</span>
								{#if onlineNicknames.has(member.xmppUsername)}
									<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"></span>
								{/if}
							</label>
						{:else}
							<p class="px-3 py-2 text-sm text-gray-500">
								{memberTab === 'online'
									? 'Nobody from your chats is online right now.'
									: memberTab === 'selected'
										? 'No members selected yet.'
										: 'No known users yet — they appear here from members of your chats.'}
							</p>
						{/each}
					</div>
				</fieldset>

				<div class="mt-4 flex justify-end gap-2">
					<Dialog.Close
						class="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
					>
						Cancel
					</Dialog.Close>
					<button
						type="submit"
						disabled={!newChatTitle.trim() || creatingChat}
						class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{creatingChat ? 'Creating…' : 'Create'}
					</button>
				</div>
			</form>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
