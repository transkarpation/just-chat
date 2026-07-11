<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import CreateChatDialog from '$lib/components/CreateChatDialog.svelte';
	import ManageMembersDialog from '$lib/components/ManageMembersDialog.svelte';
	import { getMyChats, deleteChat, type Chat, type ChatMember } from '$lib/api/chats';
	import { uploadFile, type UploadedFile } from '$lib/api/files';
	import { openImageGallery } from '$lib/lightbox';
	import { getApiErrorMessage } from '$lib/api/auth';
	import { chatsState, setChats, clearChats } from '$lib/state/chats.svelte';
	import { userLookupState, lookupUser, clearUserLookups } from '$lib/state/users.svelte';
	import { xmppState } from '$lib/state/xmpp.svelte';
	import {
		messagesState,
		lastMessage,
		clearMessages,
		forgetRoom,
		compareArchiveIds,
		type ChatMessage,
		type MessageMedia,
		type MessageMention,
		type RoomMessages
	} from '$lib/state/messages.svelte';
	import {
		connectAndJoinRooms,
		disconnectXmpp,
		loadLastMessages,
		loadOlderMessages,
		markRoomDisplayed,
		sendRoomMessage,
		sendMediaMessage,
		deleteRoomMessage,
		leaveRoom,
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
	let showMembersList = $state(false);
	let membersSearch = $state('');

	const filteredMembers = $derived.by(() => {
		if (!selectedChat) return [];
		const query = membersSearch.trim().toLowerCase();
		if (!query) return selectedChat.members;
		return selectedChat.members.filter((m) =>
			`${m.firstName} ${m.lastName}`.toLowerCase().includes(query)
		);
	});
	let draft = $state('');
	let sending = $state(false);
	let sendError = $state('');
	let showNewChat = $state(false);
	let showMembers = $state(false);

	const selectedChat = $derived(
		chatsState.items.find((chat) => chat.name === selectedRoom) ?? null
	);
	// a roomId in the URL means the message pane is "open" — on mobile the
	// list and the conversation are two screens, and this picks which one
	// shows (it also covers the joining-from-a-link state, when the room is
	// not in chatsState yet)
	const roomPaneOpen = $derived(page.url.searchParams.get('roomId') !== null);
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

	// returning to the tab means the open conversation is being read again —
	// push the read watermark for messages that arrived while it was hidden
	onMount(() => {
		const onVisible = () => {
			if (!document.hidden && selectedRoom) {
				markRoomDisplayed(selectedRoom);
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
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
		showMembersList = false;
		membersSearch = '';
		sendError = '';
		joinError = '';
		deleteError = '';
		prevNewestId = null;
		// history already in state (chat was opened before) — jump right away
		await scrollToBottom();
		// autofocus only on the desktop layout — on mobile it would pop the
		// on-screen keyboard over the freshly opened chat
		if (window.matchMedia('(min-width: 768px)').matches) {
			composerEl?.focus();
		}
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
			// the user is looking at the conversation now — mark it read
			markRoomDisplayed(roomName);
		}
	}

	// the server-side title of a private (1-1) chat is unreliable — show
	// the other participant's name instead
	function chatTitle(chat: Chat): string {
		if (chat.type === 'private') {
			const other = chat.members.find((m) => m.xmppUsername !== myNickname);
			if (other) return `${other.firstName} ${other.lastName}`.trim();
		}
		return chat.title;
	}

	function nickToName(chat: Chat, nickname: string): string {
		if (nickname === myNickname) return 'You';
		const member = chat.members.find((m) => m.xmppUsername === nickname);
		if (member) return `${member.firstName} ${member.lastName}`.trim();
		// sender is not a member (anymore) — use the looked-up user record
		const record = userLookupState.records[nickname];
		if (record) return `${record.firstName} ${record.lastName}`.trim() + ' (former member)';
		if (record === null) return 'Deleted user';
		// lookup still running — show a short readable piece of the nickname
		return nickname.split('_')[1]?.slice(0, 8) ?? nickname;
	}

	function senderName(chat: Chat, message: ChatMessage): string {
		return nickToName(chat, message.nickname);
	}

	/** avatar URL from /chats/my member data (or the user lookup for senders
	 * who are no longer members), if the sender has set one */
	function senderAvatar(chat: Chat, message: ChatMessage): string | undefined {
		const member = chat.members.find((m) => m.xmppUsername === message.nickname);
		if (member) return member.profileImage || undefined;
		return userLookupState.records[message.nickname]?.profileImage || undefined;
	}

	// resolve senders that are missing from the open chat's member list
	// (removed from the chat or account deleted) via the users API
	$effect(() => {
		const chat = selectedChat;
		const messages = selectedMessages?.messages;
		if (!chat || !messages) return;
		const members = new Set(chat.members.map((m) => m.xmppUsername));
		for (const message of messages) {
			if (message.nickname !== myNickname && !members.has(message.nickname)) {
				lookupUser(message.nickname);
			}
		}
	});

	type BodyPart =
		| { type: 'text'; value: string }
		| { type: 'link'; value: string; href: string; internal: boolean }
		| { type: 'mention'; value: string; xmppUsername: string };

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

	// slice the body into mention spans (by the stanza's reference ranges) and
	// run the text in between through linkify
	function bodyParts(message: ChatMessage): BodyPart[] {
		const mentions = [...(message.mentions ?? [])]
			.filter((m) => m.begin >= 0 && m.end <= message.body.length)
			.sort((a, b) => a.begin - b.begin);
		if (mentions.length === 0) return linkify(message.body);
		const parts: BodyPart[] = [];
		let cursor = 0;
		for (const mention of mentions) {
			if (mention.begin < cursor) continue; // overlapping range — ignore
			if (mention.begin > cursor) {
				parts.push(...linkify(message.body.slice(cursor, mention.begin)));
			}
			parts.push({
				type: 'mention',
				value: message.body.slice(mention.begin, mention.end),
				xmppUsername: mention.xmppUsername
			});
			cursor = mention.end;
		}
		if (cursor < message.body.length) {
			parts.push(...linkify(message.body.slice(cursor)));
		}
		return parts;
	}

	/** how many OTHER members read / received an own message: readers come
	 * from per-user watermarks (marker id >= message id), delivered is the
	 * union of explicit receipts and readers (reading implies receiving) */
	function deliveryStats(
		room: RoomMessages,
		message: ChatMessage
	): { read: number; delivered: number } {
		const readers = new Set<string>();
		for (const [nickname, upTo] of Object.entries(room.displayedUpTo)) {
			if (nickname !== myNickname && compareArchiveIds(message.id, upTo) <= 0) {
				readers.add(nickname);
			}
		}
		const delivered = new Set(readers);
		for (const nickname of message.receivedBy ?? []) {
			if (nickname !== myNickname) delivered.add(nickname);
		}
		return { read: readers.size, delivered: delivered.size };
	}

	function formatTime(timestamp: string): string {
		if (!timestamp) return '';
		return new Date(timestamp).toLocaleString();
	}

	// the create dialog closes before the new chat is in chatsState — the
	// overlay spinner covers that gap so the UI doesn't look idle
	let syncingNewChat = $state(false);

	// the dialog created the chat; sync everything around it and open it —
	// a failed sync step must not stop the chat from opening
	async function onChatCreated(roomName: string) {
		syncingNewChat = true;
		try {
			try {
				// refetch so the new chat has the canonical /chats/my shape
				const chats = await getMyChats();
				setChats(chats.items);
			} catch (err) {
				console.error('chat list refetch after create failed:', err);
			}
			try {
				const xmppUsername = localStorage.getItem('xmppUsername');
				const xmppPassword = localStorage.getItem('xmppPassword');
				if (xmppUsername && xmppPassword) {
					const roomNames = chatsState.items.map((chat) => chat.name);
					await connectAndJoinRooms(xmppUsername, xmppPassword, roomNames);
					await loadLastMessages(roomNames);
				}
			} catch (err) {
				console.error('XMPP sync after create failed:', err);
			}
			await selectChat(roomName);
		} finally {
			syncingNewChat = false;
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

	let leavingChat = $state(false);
	let confirmLeaveOpen = $state(false);

	async function leaveCurrentChat() {
		if (!selectedChat || leavingChat) return;
		leavingChat = true;
		deleteError = '';
		try {
			// removes the room from local state itself; the backend drops
			// the membership asynchronously
			await leaveRoom(selectedChat.name);
		} catch (err) {
			console.error('leaving chat failed:', err);
			deleteError = 'Failed to leave the chat. Check the connection and try again.';
		} finally {
			leavingChat = false;
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

	let mediaInputEl = $state<HTMLInputElement | null>(null);
	// picked files are uploaded right away and staged next to the composer;
	// Send ships them all in one message with the typed text as the caption
	let pendingAttachments = $state<UploadedFile[]>([]);
	let uploadingCount = $state(0);

	async function stageAttachments(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = ''; // allow re-selecting the same file
		if (files.length === 0 || !selectedRoom) return;
		sendError = '';
		uploadingCount += files.length;
		await Promise.all(
			files.map(async (file) => {
				try {
					const uploaded = await uploadFile(file);
					pendingAttachments = [...pendingAttachments, uploaded];
				} catch (err) {
					console.error('file upload failed:', err);
					sendError = 'Failed to upload a file. Check the connection and try again.';
				} finally {
					uploadingCount -= 1;
				}
			})
		);
	}

	function removeAttachment(index: number) {
		pendingAttachments = pendingAttachments.filter((_, i) => i !== index);
	}

	// fetch → blob → <a download>: saves the file without opening a tab
	// (a target="_blank" link flashes a new tab that instantly closes);
	// the files server allows cross-origin fetches from the app
	async function downloadFile(media: MessageMedia) {
		try {
			const response = await fetch(media.location);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = media.originalName || 'file';
			link.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error('download failed:', err);
			window.open(media.location, '_blank', 'noopener');
		}
	}

	// every image of the open chat, oldest → newest — one PhotoSwipe gallery,
	// so the viewer can swipe between all pictures of the conversation
	const roomImages = $derived.by(() => {
		const images: { messageId: string; media: MessageMedia }[] = [];
		for (const message of selectedMessages?.messages ?? []) {
			for (const media of message.media ?? []) {
				if (media.mimetype.startsWith('image/')) images.push({ messageId: message.id, media });
			}
		}
		return images;
	});

	function openImage(messageId: string, location: string) {
		const index = roomImages.findIndex(
			(image) => image.messageId === messageId && image.media.location === location
		);
		if (index === -1) return;
		openImageGallery(
			roomImages.map(({ media }) => ({
				src: media.location,
				msrc: media.locationPreview,
				alt: media.originalName
			})),
			index
		);
	}

	let messageToDelete = $state<ChatMessage | null>(null);
	let confirmDeleteMessageOpen = $state(false);

	function askDeleteMessage(message: ChatMessage) {
		if (message.pending) return; // no archive id yet — nothing to delete
		messageToDelete = message;
		confirmDeleteMessageOpen = true;
	}

	async function deleteMessageConfirmed() {
		const message = messageToDelete;
		messageToDelete = null;
		if (!message) return;
		try {
			// the message disappears from state when the server reflects
			// the <delete> back to the room
			await deleteRoomMessage(message.roomName, message.id);
		} catch (err) {
			console.error('message delete failed:', err);
			sendError = 'Failed to delete the message. Check the connection and try again.';
		}
	}

	function formatSize(bytes: number): string {
		if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${bytes} B`;
	}

	// --- @-mention autocomplete in the composer ---
	// what the user actually picked from the dropdown; at send time each text
	// still present in the message becomes a mention reference
	let draftMentions = $state<{ xmppUsername: string; text: string }[]>([]);
	/** text typed after the active "@" (may contain a space for last names);
	 * null = no active mention token at the caret */
	let mentionQuery = $state<string | null>(null);
	let mentionTokenStart = 0;
	let mentionIndex = $state(0);

	const mentionCandidates = $derived.by(() => {
		if (mentionQuery === null || !selectedChat) return [];
		const query = mentionQuery.toLowerCase();
		return selectedChat.members
			.filter((m) => m.xmppUsername !== myNickname)
			.filter((m) => `${m.firstName} ${m.lastName}`.toLowerCase().includes(query))
			.slice(0, 8);
	});

	// find an "@token" ending at the caret; @ must start the text or follow
	// whitespace so email-like strings don't trigger the dropdown
	function updateMentionToken() {
		const caret = composerEl?.selectionStart;
		if (caret == null) {
			mentionQuery = null;
			return;
		}
		const upToCaret = draft.slice(0, caret);
		const at = upToCaret.lastIndexOf('@');
		if (at === -1 || (at > 0 && !/\s/.test(upToCaret[at - 1]))) {
			mentionQuery = null;
			return;
		}
		const token = upToCaret.slice(at + 1);
		if (token.length > 40) {
			mentionQuery = null;
			return;
		}
		mentionTokenStart = at;
		if (mentionQuery !== token) mentionIndex = 0;
		mentionQuery = token;
	}

	async function pickMention(member: ChatMember) {
		const text = `@${member.firstName} ${member.lastName}`.trim();
		const caret = composerEl?.selectionStart ?? draft.length;
		draft = draft.slice(0, mentionTokenStart) + text + ' ' + draft.slice(caret);
		if (!draftMentions.some((m) => m.text === text && m.xmppUsername === member.xmppUsername)) {
			draftMentions = [...draftMentions, { xmppUsername: member.xmppUsername, text }];
		}
		const position = mentionTokenStart + text.length + 1;
		mentionQuery = null;
		await tick(); // let the input take the new value before moving the caret
		composerEl?.focus();
		composerEl?.setSelectionRange(position, position);
	}

	function composerKeydown(event: KeyboardEvent) {
		if (mentionQuery === null || mentionCandidates.length === 0) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			mentionIndex = (mentionIndex + 1) % mentionCandidates.length;
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			mentionIndex = (mentionIndex - 1 + mentionCandidates.length) % mentionCandidates.length;
		} else if (event.key === 'Enter' || event.key === 'Tab') {
			// pick instead of submitting the form / leaving the field
			event.preventDefault();
			pickMention(mentionCandidates[mentionIndex]);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			mentionQuery = null;
		}
	}

	// every occurrence of a picked mention text in the final message becomes a
	// reference; longer names first so "@Ann Lee Smith" wins over "@Ann Lee"
	function collectMentions(text: string): MessageMention[] {
		const found: MessageMention[] = [];
		const ordered = [...draftMentions].sort((a, b) => b.text.length - a.text.length);
		for (const mention of ordered) {
			let searchFrom = 0;
			for (;;) {
				const begin = text.indexOf(mention.text, searchFrom);
				if (begin === -1) break;
				const end = begin + mention.text.length;
				if (!found.some((m) => begin < m.end && end > m.begin)) {
					found.push({ begin, end, xmppUsername: mention.xmppUsername });
				}
				searchFrom = end;
			}
		}
		return found.sort((a, b) => a.begin - b.begin);
	}

	async function sendMessage() {
		const text = draft.trim();
		const attachments = pendingAttachments;
		if ((!text && attachments.length === 0) || !selectedRoom || sending || uploadingCount > 0) {
			return;
		}
		sending = true;
		sendError = '';
		try {
			if (attachments.length > 0) {
				// the typed text rides along as the caption
				await sendMediaMessage(selectedRoom, attachments, text);
				pendingAttachments = [];
			} else {
				const mentions = collectMentions(text);
				await sendRoomMessage(selectedRoom, text, mentions.length > 0 ? mentions : undefined);
			}
			draft = '';
			draftMentions = [];
			mentionQuery = null;
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
		clearUserLookups();
		goto('/login');
	}
</script>

<svelte:head>
	<title>User page</title>
</svelte:head>

<!-- h-dvh, not h-screen: mobile 100vh overshoots the visible viewport and
     hides the composer behind the browser chrome -->
<div class="flex h-dvh justify-center bg-gray-100 dark:bg-black">
	<!-- cap the app width on large screens; children keep their layout -->
	<div class="flex h-full w-full max-w-6xl flex-col border-gray-200 bg-gray-50 xl:border-x dark:border-gray-800 dark:bg-gray-950">
	<header class="shrink-0 border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
		<div class="flex items-center justify-between px-4 py-3 sm:px-6">
			<h1 class="text-lg font-semibold text-gray-900 dark:text-gray-100">User page</h1>
			<div class="flex items-center gap-4">
				<span class="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400">
					<span
						class="h-2 w-2 rounded-full {xmppState.status === 'online'
							? 'bg-green-500'
							: 'bg-gray-300 dark:bg-gray-600'}"
					></span>
					XMPP {xmppState.status}
				</span>
				<a
					href="/profile"
					class="text-sm font-medium text-gray-700 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400"
					title="Open profile"
				>
					{#if userEmail}
						<span class="hidden sm:inline">{userEmail}</span>
						<span class="sm:hidden">Profile</span>
					{:else}
						Profile
					{/if}
				</a>
				<ThemeToggle />
				<button
					type="button"
					onclick={logout}
					class="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-gray-800"
				>
					Log out
				</button>
			</div>
		</div>
	</header>

	{#if !notifBannerDismissed && notifPermission === 'default'}
		<div class="flex shrink-0 items-center justify-between gap-4 border-b border-indigo-100 bg-indigo-50 px-4 py-2.5 sm:px-6 dark:border-indigo-900 dark:bg-indigo-950">
			<p class="text-sm text-indigo-900 dark:text-indigo-200">
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
					class="rounded-md px-2 py-1 text-sm text-indigo-400 hover:bg-indigo-100 hover:text-indigo-600 dark:hover:bg-indigo-900 dark:hover:text-indigo-300"
				>
					✕
				</button>
			</div>
		</div>
	{:else if !notifBannerDismissed && notifPermission === 'denied'}
		<div class="flex shrink-0 items-center justify-between gap-4 border-b border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-6 dark:border-amber-900 dark:bg-amber-950">
			<p class="text-sm text-amber-900 dark:text-amber-200">
				Notifications are blocked for this site. You won't be alerted about new messages —
				to change this, allow notifications in your browser's site settings (the icon next
				to the address bar).
			</p>
			<button
				type="button"
				onclick={() => (notifBannerDismissed = true)}
				aria-label="Dismiss"
				class="shrink-0 rounded-md px-2 py-1 text-sm text-amber-500 hover:bg-amber-100 hover:text-amber-700 dark:hover:bg-amber-900 dark:hover:text-amber-300"
			>
				✕
			</button>
		</div>
	{/if}

	<div class="flex min-h-0 flex-1">
		<!-- chat list: full-screen on mobile (hidden when a chat is open),
		     fixed-width column next to the messages on md+ -->
		<aside class="{roomPaneOpen ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-gray-200 bg-white md:w-80 dark:border-gray-800 dark:bg-gray-900">
			<div class="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
				<h2 class="text-sm font-semibold text-gray-900 dark:text-gray-100">My chats</h2>
				<div class="flex items-center gap-2">
					{#if chatsState.loaded}
						<span class="text-xs text-gray-500 dark:text-gray-400">{chatsState.items.length} total</span>
					{/if}
					<button
						type="button"
						onclick={() => (showNewChat = true)}
						class="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold text-white hover:bg-indigo-500"
					>
						+ New
					</button>
				</div>
			</div>

			<div class="min-h-0 flex-1 overflow-y-auto">
				{#if loading}
					<p class="p-4 text-sm text-gray-500 dark:text-gray-400">Loading chats…</p>
				{:else if error}
					<p class="p-4 text-sm text-red-700 dark:text-red-400" role="alert">{error}</p>
				{:else if chatsState.items.length === 0}
					<p class="p-4 text-sm text-gray-500 dark:text-gray-400">You have no chats yet.</p>
				{:else}
					<ul class="divide-y divide-gray-100 dark:divide-gray-800">
						{#each sortedChats as chat (chat._id)}
							{@const last = lastMessage(chat.name)}
							{@const selected = selectedRoom === chat.name}
							<li>
								<button
									type="button"
									onclick={() => selectChat(chat.name)}
									class="flex w-full items-center gap-3 px-4 py-3 text-left {selected
										? 'bg-indigo-50 dark:bg-indigo-950'
										: 'hover:bg-gray-50 dark:hover:bg-gray-800'}"
								>
									{#if chat.picture}
										<img
											src={chat.picture}
											alt=""
											class="h-10 w-10 shrink-0 rounded-full object-cover"
										/>
									{:else}
										<div
											class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
										>
											{chatTitle(chat).charAt(0).toUpperCase()}
										</div>
									{/if}

									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-1.5">
											<p class="truncate text-sm font-medium text-gray-900 dark:text-gray-100">{chatTitle(chat)}</p>
											{#if chat.createdBy && chat.createdBy === myUserId}
												<span
													class="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
												>
													yours
												</span>
											{/if}
											{#if xmppState.joinedRooms.includes(chat.name)}
												<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"></span>
											{/if}
										</div>
										{#if last}
											<p class="truncate text-xs text-gray-500 dark:text-gray-400">
												<span class="font-medium">{senderName(chat, last)}:</span>
												{last.media
												? `📎 ${
														last.body !== 'media'
															? last.body
															: last.media.length > 1
																? `${last.media.length} files`
																: last.media[0].originalName || 'file'
													}`
												: last.body}
											</p>
										{:else if chat.description}
											<p class="truncate text-xs text-gray-500 dark:text-gray-400">{chat.description}</p>
										{/if}
									</div>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</aside>

		<!-- message area: full-screen on mobile when a chat is open -->
		<!-- min-w-0: without it the pane refuses to shrink below the chat
		     header's intrinsic width and overflows narrow screens -->
		<section class="{roomPaneOpen ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-1 flex-col">
			{#if selectedChat}
				<div
					class="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 py-3 sm:px-6 dark:border-gray-800 dark:bg-gray-900"
				>
					<button
						type="button"
						onclick={() => goto('/')}
						aria-label="Back to chat list"
						class="shrink-0 rounded-md px-2 py-1.5 text-lg leading-none text-gray-600 hover:bg-gray-100 md:hidden dark:text-gray-300 dark:hover:bg-gray-800"
					>
						←
					</button>
					<div class="relative min-w-0 flex-1">
						<h3 class="truncate font-semibold text-gray-900 dark:text-gray-100">{chatTitle(selectedChat)}</h3>
						<p class="text-xs text-gray-500 dark:text-gray-400">
							<button
								type="button"
								onclick={() => {
									showMembersList = !showMembersList;
									showOnlineList = false;
									membersSearch = '';
								}}
								class="font-medium underline-offset-2 hover:underline"
								aria-expanded={showMembersList}
							>
								{selectedChat.members.length}
								{selectedChat.members.length === 1 ? 'member' : 'members'}
							</button>
							<span class="mx-1">·</span>
							<button
								type="button"
								onclick={() => {
									showOnlineList = !showOnlineList;
									showMembersList = false;
								}}
								class="font-medium text-green-600 underline-offset-2 hover:underline dark:text-green-400"
								aria-expanded={showOnlineList}
							>
								{xmppState.occupants[selectedChat.name]?.length ?? 0} online
							</button>
						</p>

						{#if showOnlineList || showMembersList}
							<!-- click-away backdrop -->
							<button
								type="button"
								class="fixed inset-0 z-10 cursor-default"
								aria-label="Close the list"
								onclick={() => {
									showOnlineList = false;
									showMembersList = false;
								}}
							></button>
						{/if}
						{#if showOnlineList}
							<div
								class="absolute top-full left-0 z-20 mt-1 max-h-64 w-64 overflow-y-auto rounded-lg bg-white py-1 shadow-lg ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700"
							>
								{#each xmppState.occupants[selectedChat.name] ?? [] as nickname (nickname)}
									{@const occupant = selectedChat.members.find((m) => m.xmppUsername === nickname)}
									{@const name = nickToName(selectedChat, nickname)}
									<div class="flex items-center gap-2.5 px-3 py-1.5 text-sm text-gray-800 dark:text-gray-200">
										{#if occupant?.profileImage}
											<img
												src={occupant.profileImage}
												alt=""
												class="relative h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-gray-200 transition-transform duration-150 ease-out hover:z-10 hover:scale-[1.8] dark:ring-gray-700"
											/>
										{:else}
											<span
												class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-300"
											>
												{name.charAt(0).toUpperCase()}
											</span>
										{/if}
										<span class="min-w-0 flex-1 truncate">{name}</span>
										<span class="h-2 w-2 shrink-0 rounded-full bg-green-500"></span>
									</div>
								{:else}
									<p class="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">Nobody is online.</p>
								{/each}
							</div>
						{/if}
						{#if showMembersList}
							<div
								class="absolute top-full left-0 z-20 mt-1 flex max-h-64 w-64 flex-col rounded-lg bg-white py-1 shadow-lg ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700"
							>
								<div class="shrink-0 px-2 pb-1.5">
									<input
										type="search"
										bind:value={membersSearch}
										placeholder="Search by name…"
										class="block w-full rounded-md border-0 bg-white px-2.5 py-1 text-sm text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 dark:bg-gray-900 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500"
									/>
								</div>
								<div class="min-h-0 flex-1 overflow-y-auto">
								{#each filteredMembers as member (member.xmppUsername)}
									{@const name = `${member.firstName} ${member.lastName}`.trim()}
									<div class="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-800 dark:text-gray-200">
										{#if member.profileImage}
											<img
												src={member.profileImage}
												alt=""
												class="relative h-8 w-8 shrink-0 rounded-full object-cover ring-1 ring-gray-200 transition-transform duration-150 ease-out hover:z-10 hover:scale-[1.8] dark:ring-gray-700"
											/>
										{:else}
											<span
												class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-300"
											>
												{name.charAt(0).toUpperCase()}
											</span>
										{/if}
										<span class="min-w-0 flex-1 truncate">
											{member.xmppUsername === myNickname ? `${name} (you)` : name}
										</span>
										{#if member._id === selectedChat.createdBy}
											<span
												class="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
											>
												owner
											</span>
										{/if}
										{#if xmppState.occupants[selectedChat.name]?.includes(member.xmppUsername)}
											<span class="h-2 w-2 shrink-0 rounded-full bg-green-500"></span>
										{/if}
									</div>
								{:else}
									<p class="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
										{membersSearch.trim() ? 'No one matches your search.' : 'No members.'}
									</p>
								{/each}
								</div>
							</div>
						{/if}
					</div>
					<div class="flex shrink-0 items-center gap-2">
						{#if selectedChat.createdBy && selectedChat.createdBy === myUserId}
							<span
								class="hidden rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700 sm:inline dark:bg-indigo-900 dark:text-indigo-300"
							>
								created by you
							</span>
							{#if selectedChat.type !== 'private'}
								<button
									type="button"
									onclick={() => (showMembers = true)}
									class="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-gray-800"
								>
									Members
								</button>
							{/if}
							<button
								type="button"
								onclick={() => (confirmDeleteOpen = true)}
								disabled={deletingChat}
								class="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-50 disabled:opacity-50 dark:bg-gray-900 dark:text-red-400 dark:ring-red-900 dark:hover:bg-red-950"
							>
								{deletingChat ? 'Deleting…' : 'Delete'}
							</button>
						{:else}
							<button
								type="button"
								onclick={() => (confirmLeaveOpen = true)}
								disabled={leavingChat || xmppState.status !== 'online'}
								class="rounded-md bg-white px-2.5 py-1 text-xs font-medium text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-50 disabled:opacity-50 dark:bg-gray-900 dark:text-red-400 dark:ring-red-900 dark:hover:bg-red-950"
							>
								{leavingChat ? 'Leaving…' : 'Leave'}
							</button>
						{/if}
						<button
							type="button"
							onclick={copyRoomLink}
							class="rounded-md bg-white px-2.5 py-1 text-xs font-medium dark:bg-gray-900 {linkCopied
								? 'text-green-600 ring-green-300 dark:text-green-400 dark:ring-green-800'
								: 'text-gray-700 ring-gray-300 hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-gray-800'} ring-1 ring-inset"
						>
							{linkCopied ? 'Copied!' : 'Copy link'}
						</button>
						{#if xmppState.joinedRooms.includes(selectedChat.name)}
							<span
								class="hidden rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700 sm:inline dark:bg-green-950 dark:text-green-300"
							>
								joined
							</span>
						{/if}
						<span
							class="hidden rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 sm:inline dark:bg-gray-800 dark:text-gray-300"
						>
							{selectedChat.type}
						</span>
					</div>
				</div>

				{#if deleteError}
					<div class="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 sm:px-6 dark:border-red-900 dark:bg-red-950 dark:text-red-300" role="alert">
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
								class="rounded-md bg-white px-3 py-1 text-xs font-medium text-indigo-600 ring-1 ring-inset ring-gray-200 hover:bg-indigo-50 disabled:opacity-50 dark:bg-gray-900 dark:text-indigo-400 dark:ring-gray-700 dark:hover:bg-gray-800"
							>
								{selectedMessages.loading ? 'Loading…' : 'Load older messages'}
							</button>
						</div>
					{/if}

					{#if !selectedMessages || selectedMessages.messages.length === 0}
						<p class="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
							{selectedMessages?.loading ? 'Loading messages…' : 'No messages in this chat yet.'}
						</p>
					{:else}
						<ul class="space-y-4">
							{#each selectedMessages.messages as message (message.id)}
								{@const mine = message.nickname === myNickname}
								{@const avatar = senderAvatar(selectedChat, message)}
								<li class="group flex items-end gap-2 {mine ? 'justify-end' : 'justify-start'}">
									{#if mine && !message.pending}
										<button
											type="button"
											onclick={() => askDeleteMessage(message)}
											aria-label="Delete message"
											title="Delete message"
											class="self-center rounded-md p-1 text-sm text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gray-200 hover:text-red-600 focus-visible:opacity-100 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-red-400"
										>
											🗑
										</button>
									{/if}
									{#if !mine}
										{#if avatar}
											<img
												src={avatar}
												alt=""
												class="relative h-10 w-10 shrink-0 rounded-full object-cover ring-1 ring-gray-200 transition-transform duration-150 ease-out hover:z-10 hover:scale-[1.8] dark:ring-gray-700"
											/>
										{:else}
											<div
												class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-200 text-sm font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-300"
											>
												{senderName(selectedChat, message).charAt(0).toUpperCase()}
											</div>
										{/if}
									{/if}
									<!-- min-w-0 lets this flex item shrink below the 400px media
									     block's intrinsic width (flex items refuse to otherwise, which
									     caused horizontal scroll on phones); the max-w chain then caps
									     each level, so the block gets min(400px, available width) -->
									<div class="flex min-w-0 max-w-[85%] flex-col md:max-w-[75%] {mine ? 'items-end' : 'items-start'}">
									<div
										class="max-w-full rounded-2xl px-4 py-2 {mine
											? 'rounded-br-sm bg-indigo-600 text-white'
											: 'rounded-bl-sm bg-white text-gray-900 ring-1 ring-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700'}"
									>
										<div class="flex items-baseline gap-2">
											<span
												class="text-sm font-semibold {mine
													? 'text-indigo-100'
													: 'text-indigo-600 dark:text-indigo-400'}"
											>
												{senderName(selectedChat, message)}
											</span>
											<span class="text-xs {mine ? 'text-indigo-200' : 'text-gray-400 dark:text-gray-500'}">
												{formatTime(message.timestamp)}
											</span>
										</div>
										{#if message.media}
											{@const newest = message.id === selectedMessages.messages.at(-1)?.id}
											{@const images = message.media.filter((m) => m.mimetype.startsWith('image/'))}
											{@const others = message.media.filter((m) => !m.mimetype.startsWith('image/'))}
											<!-- media messages get a fixed 400px block (whatever the mix of
											     images and files) so previews stay readable; max-w-full lets
											     it shrink inside the 75% bubble cap on narrow screens -->
											<div class="mt-1 w-[400px] max-w-full space-y-1">
											{#if images.length === 1}
												<button
													type="button"
													onclick={() => openImage(message.id, images[0].location)}
													class="block w-full cursor-zoom-in"
													aria-label="View {images[0].originalName || 'image'} full size"
												>
													<!-- the image gets its height after the scroll-to-bottom ran;
													     re-scroll when the newest one finishes loading -->
													<img
														src={images[0].locationPreview}
														alt={images[0].originalName}
														onload={newest ? () => scrollToBottom() : undefined}
														class="max-h-80 w-full rounded-lg object-cover"
													/>
												</button>
											{:else if images.length > 1}
												<!-- collage: 2 side by side, 3 = one tall on the left + two
												     stacked, 4+ = a 2x2 grid with a "+N" veil on the last cell;
												     the veiled images are reachable by swiping in the gallery -->
												{@const shown = images.slice(0, 4)}
												{@const extra = images.length - shown.length}
												<div class="grid w-full grid-cols-2 gap-1">
													{#each shown as media, mi (media.location + mi)}
														{@const tall = images.length === 3 && mi === 0}
														<button
															type="button"
															onclick={() => openImage(message.id, media.location)}
															class="relative block cursor-zoom-in overflow-hidden rounded-lg {tall
																? 'row-span-2'
																: 'aspect-square'}"
															aria-label="View {media.originalName || 'image'} full size"
														>
															<img
																src={media.locationPreview}
																alt={media.originalName}
																class="h-full w-full object-cover"
															/>
															{#if extra > 0 && mi === shown.length - 1}
																<span
																	class="absolute inset-0 flex items-center justify-center bg-black/40 text-2xl font-semibold text-white"
																>
																	+{extra}
																</span>
															{/if}
														</button>
													{/each}
												</div>
											{/if}
											{#each others as media, mi (media.location + mi)}
												{#if media.mimetype.startsWith('video/')}
													<!-- svelte-ignore a11y_media_has_caption -->
													<video src={media.location} controls class="max-h-64 w-full rounded-lg"
													></video>
												{:else if media.mimetype.startsWith('audio/')}
													<audio src={media.location} controls class="w-full"></audio>
												{:else}
													<div
														class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 {mine
															? 'bg-indigo-500/60'
															: 'bg-gray-100 dark:bg-gray-700'}"
													>
														<span
															class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold uppercase {mine
																? 'bg-indigo-800/70 text-indigo-100'
																: 'bg-gray-600 text-gray-100 dark:bg-gray-900'}"
														>
															{(media.originalName.includes('.')
																? media.originalName.split('.').pop()!
																: 'file'
															).slice(0, 4)}
														</span>
														<span class="min-w-0 flex-1">
															<span class="block truncate text-base font-medium">
																{media.originalName || 'file'}
															</span>
															<span class="block text-xs {mine ? 'text-indigo-200' : 'text-gray-500 dark:text-gray-400'}">
																{formatSize(media.size)}
															</span>
														</span>
														<button
															type="button"
															onclick={() => downloadFile(media)}
															title="Download {media.originalName || 'file'}"
															aria-label="Download {media.originalName || 'file'}"
															class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base {mine
																? 'bg-indigo-800/70 text-white hover:bg-indigo-800'
																: 'bg-white text-gray-700 shadow-sm hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-600'}"
														>
															↓
														</button>
													</div>
												{/if}
											{/each}
											</div>
											{#if message.body && message.body !== 'media'}
												<!-- the caption travels in the body ("media" = no caption) -->
												<p class="mt-1 text-base whitespace-pre-wrap">{message.body}</p>
											{/if}
										{:else}
											<p class="text-base whitespace-pre-wrap">
												{#each bodyParts(message) as part, i (i)}
													{#if part.type === 'link'}
														<a
															href={part.href}
															target={part.internal ? undefined : '_blank'}
															rel={part.internal ? undefined : 'noopener noreferrer'}
															class="font-medium underline underline-offset-2 {mine
																? 'text-white hover:text-indigo-100'
																: 'text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300'}"
														>{part.value}</a>
													{:else if part.type === 'mention'}
														<span
															class="rounded px-1 font-medium {part.xmppUsername === myNickname
																? 'bg-amber-200 text-amber-900 dark:bg-amber-400/30 dark:text-amber-200'
																: mine
																	? 'bg-indigo-500 text-white'
																	: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300'}"
														>{part.value}</span>
													{:else}
														{part.value}
													{/if}
												{/each}
											</p>
										{/if}
									</div>
									{#if mine}
										<!-- delivery status: ✓ when the server echoed the message
										     back, gray ✓✓ when at least one other member's client
										     confirmed delivery, blue ✓✓ when at least one has read
										     it; hover shows both counts -->
										{@const stats = deliveryStats(selectedMessages, message)}
										{@const status = message.pending
											? 'Sending…'
											: stats.read > 0
												? `Read by ${stats.read} · Delivered to ${stats.delivered}`
												: stats.delivered > 0
													? `Delivered to ${stats.delivered}`
													: 'Delivered to server'}
										<span
											class="mt-0.5 text-sm leading-none {stats.read > 0
												? 'text-sky-500 dark:text-sky-400'
												: 'text-gray-400 dark:text-gray-500'}"
											title={status}
											aria-label={status}
										>
											{message.pending ? '…' : stats.delivered > 0 ? '✓✓' : '✓'}
										</span>
									{/if}
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<form
					class="relative shrink-0 border-t border-gray-200 bg-white px-4 py-3 sm:px-6 dark:border-gray-800 dark:bg-gray-900"
					onsubmit={(event) => {
						event.preventDefault();
						sendMessage();
					}}
				>
					{#if mentionQuery !== null && mentionCandidates.length > 0}
						<!-- preventDefault on mousedown keeps the input focused so a
						     click lands on the option instead of racing with blur -->
						<div
							role="listbox"
							tabindex="-1"
							onmousedown={(event) => event.preventDefault()}
							class="absolute right-4 bottom-full left-4 z-30 mb-1 max-h-56 overflow-y-auto rounded-lg bg-white py-1 shadow-lg ring-1 ring-gray-200 sm:right-6 sm:left-6 dark:bg-gray-800 dark:ring-gray-700"
						>
							{#each mentionCandidates as member, i (member.xmppUsername)}
								<button
									type="button"
									role="option"
									aria-selected={i === mentionIndex}
									onclick={() => pickMention(member)}
									onmouseenter={() => (mentionIndex = i)}
									class="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm {i ===
									mentionIndex
										? 'bg-indigo-50 dark:bg-indigo-950'
										: ''}"
								>
									{#if member.profileImage}
										<img
											src={member.profileImage}
											alt=""
											class="h-7 w-7 shrink-0 rounded-full object-cover ring-1 ring-gray-200 dark:ring-gray-700"
										/>
									{:else}
										<div
											class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-300"
										>
											{`${member.firstName} ${member.lastName}`.trim().charAt(0).toUpperCase()}
										</div>
									{/if}
									<span class="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">
										{`${member.firstName} ${member.lastName}`.trim()}
									</span>
									{#if selectedRoom && xmppState.occupants[selectedRoom]?.includes(member.xmppUsername)}
										<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"></span>
									{/if}
								</button>
							{/each}
						</div>
					{/if}
					{#if sendError}
						<p class="mb-2 text-xs text-red-600 dark:text-red-400" role="alert">{sendError}</p>
					{/if}
					{#if pendingAttachments.length > 0 || uploadingCount > 0}
						<div class="mb-2 flex flex-wrap items-center gap-2">
							{#each pendingAttachments as attachment, i (attachment._id)}
								<div
									class="relative rounded-lg ring-1 ring-gray-200 dark:ring-gray-700 {attachment.mimetype.startsWith(
										'image/'
									)
										? ''
										: 'flex items-center gap-1.5 bg-gray-100 py-1 pr-7 pl-2 dark:bg-gray-800'}"
								>
									{#if attachment.mimetype.startsWith('image/')}
										<img
											src={attachment.locationPreview}
											alt={attachment.originalname}
											class="h-16 w-16 rounded-lg object-cover"
										/>
									{:else}
										<span class="text-base">📎</span>
										<span class="max-w-36 truncate text-xs text-gray-700 dark:text-gray-300">
											{attachment.originalname}
										</span>
									{/if}
									<button
										type="button"
										onclick={() => removeAttachment(i)}
										title="Remove attachment"
										aria-label="Remove {attachment.originalname}"
										class="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gray-700 text-xs leading-none text-white shadow hover:bg-red-600 dark:bg-gray-600 dark:hover:bg-red-500"
									>
										×
									</button>
								</div>
							{/each}
							{#if uploadingCount > 0}
								<div
									class="flex h-16 w-16 items-center justify-center rounded-lg bg-gray-100 ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700"
									role="status"
									aria-label="Uploading…"
								>
									<div
										class="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-600 dark:border-gray-600 dark:border-t-indigo-400"
									></div>
								</div>
							{/if}
						</div>
					{/if}
					<div class="flex gap-2">
						<input type="file" multiple class="hidden" bind:this={mediaInputEl} onchange={stageAttachments} />
						<button
							type="button"
							onclick={() => mediaInputEl?.click()}
							disabled={xmppState.status !== 'online'}
							title="Attach images or files"
							aria-label="Attach images or files"
							class="shrink-0 rounded-md bg-white px-3 py-2 text-sm text-gray-600 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-gray-800"
						>
							📎
						</button>
						<input
							type="text"
							bind:this={composerEl}
							bind:value={draft}
							oninput={updateMentionToken}
							onkeydown={composerKeydown}
							onkeyup={updateMentionToken}
							onclick={updateMentionToken}
							placeholder={xmppState.status !== 'online'
								? 'Connecting…'
								: pendingAttachments.length > 0
									? 'Add a caption…'
									: 'Type a message…'}
							disabled={xmppState.status !== 'online'}
							class="block w-full rounded-md border-0 bg-white px-3 py-2 text-base text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 disabled:bg-gray-50 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500 dark:disabled:bg-gray-800/50"
						/>
						<button
							type="submit"
							disabled={(!draft.trim() && pendingAttachments.length === 0) ||
								sending ||
								uploadingCount > 0 ||
								xmppState.status !== 'online'}
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
							<p class="text-lg font-medium text-gray-900 dark:text-gray-100">Joining room…</p>
							<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
								Adding you as a member. This can take a few seconds.
							</p>
						{:else if joinError}
							<p class="text-lg font-medium text-red-700 dark:text-red-400">{joinError}</p>
							<button
								type="button"
								onclick={retryJoin}
								class="mt-3 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
							>
								Try again
							</button>
						{:else}
							<p class="text-lg font-medium text-gray-900 dark:text-gray-100">Select a chat</p>
							<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
								Choose a conversation from the list to see its messages.
							</p>
						{/if}
						<!-- on mobile this pane covers the list — offer a way back -->
						<button
							type="button"
							onclick={() => goto('/')}
							class="mt-4 text-sm font-medium text-indigo-600 hover:text-indigo-500 md:hidden dark:text-indigo-400 dark:hover:text-indigo-300"
						>
							← Back to chats
						</button>
					</div>
				</div>
			{/if}
		</section>
	</div>
	</div>
</div>

<ConfirmDialog
	bind:open={confirmLeaveOpen}
	title={`Leave "${selectedChat ? chatTitle(selectedChat) : ''}"?`}
	description="The chat will disappear from your list. You can join it again later via a room link or an invite."
	confirmLabel="Leave"
	destructive
	onconfirm={leaveCurrentChat}
/>

<ConfirmDialog
	bind:open={confirmDeleteMessageOpen}
	title="Delete this message?"
	description="The message will be removed for everyone in the room. This cannot be undone."
	confirmLabel="Delete"
	destructive
	onconfirm={deleteMessageConfirmed}
/>

<ConfirmDialog
	bind:open={confirmDeleteOpen}
	title={`Delete "${selectedChat ? chatTitle(selectedChat) : ''}"?`}
	description="The room and its message history will be removed for all members. This cannot be undone."
	confirmLabel="Delete"
	destructive
	onconfirm={deleteCurrentChat}
/>

<CreateChatDialog bind:open={showNewChat} {myNickname} oncreated={onChatCreated} />

{#if syncingNewChat}
	<div
		class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-gray-900/40 dark:bg-black/60"
		role="status"
		aria-live="polite"
	>
		<div class="h-9 w-9 animate-spin rounded-full border-[3px] border-white/30 border-t-white"></div>
		<p class="text-sm font-medium text-white">Setting up your chat…</p>
	</div>
{/if}

{#if selectedChat}
	<ManageMembersDialog bind:open={showMembers} chat={selectedChat} {myNickname} />
{/if}
