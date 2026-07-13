<script lang="ts">
	import { Dialog, Tabs } from 'bits-ui';
	import { createChat, createPrivateChat, type ChatMember } from '$lib/api/chats';
	import { uploadFile } from '$lib/api/files';
	import { getApiErrorMessage } from '$lib/api/auth';
	import { chatsState } from '$lib/state/chats.svelte';
	import { xmppState } from '$lib/state/xmpp.svelte';

	let {
		open = $bindable(false),
		myNickname,
		oncreated
	}: {
		open?: boolean;
		/** own xmppUsername — excluded from the member candidates */
		myNickname: string;
		/** called with the new room name after the chat is created; runs after
		 * the dialog closes — a failure here is logged, not shown as a create
		 * error, because the chat itself already exists */
		oncreated: (roomName: string) => Promise<void> | void;
	} = $props();

	let title = $state('');
	let chatType = $state<'public' | 'group' | 'private'>('public');
	let selectedMembers = $state<string[]>([]);
	let creating = $state(false);
	let createError = $state('');
	let memberTab = $state('all');

	// optional room picture (public/group only) — uploaded on submit
	let avatarFile = $state<File | null>(null);
	let avatarPreview = $state('');
	let avatarInput = $state<HTMLInputElement | null>(null);

	function pickAvatar(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // so picking the same file again still fires change
		if (!file || !file.type.startsWith('image/')) return;
		if (avatarPreview) URL.revokeObjectURL(avatarPreview);
		avatarFile = file;
		avatarPreview = URL.createObjectURL(file);
	}

	function clearAvatar() {
		if (avatarPreview) URL.revokeObjectURL(avatarPreview);
		avatarFile = null;
		avatarPreview = '';
	}

	// a direct chat has exactly one recipient — picking someone replaces
	// the previous pick instead of accumulating
	function toggleMember(xmppUsername: string, checked: boolean) {
		if (chatType === 'private') {
			selectedMembers = checked ? [xmppUsername] : [];
		} else {
			selectedMembers = checked
				? [...selectedMembers, xmppUsername]
				: selectedMembers.filter((u) => u !== xmppUsername);
		}
	}

	const canSubmit = $derived(
		chatType === 'private' ? selectedMembers.length === 1 : title.trim().length > 0
	);

	// start every open from a clean slate; a successful create resets the
	// form itself, but a dismissed dialog keeps the draft for reopening
	$effect(() => {
		if (open) {
			createError = '';
			memberTab = 'all';
		}
	});

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
				? memberCandidates.filter((m) => selectedMembers.includes(m.xmppUsername))
				: memberCandidates
	);

	async function submit() {
		if (!canSubmit || creating) return;
		creating = true;
		createError = '';
		let created;
		try {
			// the room picture goes up first — the create payload takes a URL
			let picture = '';
			if (chatType !== 'private' && avatarFile) {
				picture = (await uploadFile(avatarFile)).location;
			}
			// /v1/chats/private is idempotent — an existing 1-1 chat with the
			// same person is returned instead of creating a duplicate
			created =
				chatType === 'private'
					? await createPrivateChat(selectedMembers[0])
					: await createChat({
							title: title.trim(),
							type: chatType,
							members: selectedMembers,
							picture
						});
		} catch (err) {
			console.error('chat create failed:', err);
			createError = getApiErrorMessage(err);
			creating = false;
			return;
		}
		// the chat exists — close the dialog regardless of how the follow-up
		// sync goes, otherwise a sync hiccup reads as a failed create and
		// invites a duplicate retry
		title = '';
		chatType = 'public';
		selectedMembers = [];
		clearAvatar();
		creating = false;
		open = false;
		try {
			await oncreated(created.result.name);
		} catch (err) {
			console.error('post-create sync failed:', err);
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-40 bg-gray-900/40 dark:bg-black/60" />
		<Dialog.Content
			class="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900 dark:ring-1 dark:ring-gray-800"
		>
			<Dialog.Title class="text-base font-semibold text-gray-900 dark:text-gray-100">Create a new chat</Dialog.Title>

			<form
				class="mt-4"
				onsubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				{#if createError}
					<p class="mb-2 text-xs text-red-600 dark:text-red-400" role="alert">{createError}</p>
				{/if}
				{#if chatType !== 'private'}
					<div class="flex items-center gap-3">
						<input
							bind:this={avatarInput}
							type="file"
							accept="image/*"
							onchange={pickAvatar}
							class="hidden"
						/>
						<div class="relative shrink-0">
							<button
								type="button"
								onclick={() => avatarInput?.click()}
								title="Choose a chat picture"
								aria-label="Choose a chat picture"
								class="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full ring-1 ring-inset {avatarPreview
									? 'ring-gray-300 dark:ring-gray-700'
									: 'bg-gray-100 text-gray-400 ring-gray-300 hover:bg-gray-200 hover:text-gray-500 dark:bg-gray-800 dark:text-gray-500 dark:ring-gray-700 dark:hover:bg-gray-700'}"
							>
								{#if avatarPreview}
									<img src={avatarPreview} alt="" class="h-full w-full object-cover" />
								{:else}
									<!-- camera icon -->
									<svg viewBox="0 0 24 24" fill="currentColor" class="h-5 w-5" aria-hidden="true">
										<path
											d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 3 7.17 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.17L15 3H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"
										/>
									</svg>
								{/if}
							</button>
							{#if avatarPreview}
								<button
									type="button"
									onclick={clearAvatar}
									title="Remove the picture"
									aria-label="Remove the picture"
									class="absolute -top-1 -right-1 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-gray-700 text-[10px] leading-none text-white shadow hover:bg-gray-900 dark:bg-gray-600 dark:hover:bg-gray-500"
								>
									✕
								</button>
							{/if}
						</div>
						<input
							type="text"
							bind:value={title}
							placeholder="Chat title"
							class="block w-full min-w-0 flex-1 rounded-md border-0 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500"
						/>
					</div>
				{/if}

				<!-- min-w-0 overrides the fieldset default min-width: min-content,
				     which otherwise lets long member names blow out the dialog width -->
				<fieldset class="mt-4 min-w-0">
					<legend class="text-xs font-medium text-gray-700 dark:text-gray-300">Chat type</legend>
					<div class="mt-1.5 grid grid-cols-3 gap-2">
						<label
							class="cursor-pointer rounded-lg p-3 ring-1 ring-inset {chatType === 'public'
								? 'bg-indigo-50 ring-indigo-600 dark:bg-indigo-950 dark:ring-indigo-500'
								: 'ring-gray-300 hover:bg-gray-50 dark:ring-gray-700 dark:hover:bg-gray-800'}"
						>
							<input type="radio" bind:group={chatType} value="public" class="sr-only" />
							<span class="block text-sm font-medium text-gray-900 dark:text-gray-100">Public</span>
							<span class="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
								Anyone in the app can join via a link.
							</span>
						</label>
						<label
							class="cursor-pointer rounded-lg p-3 ring-1 ring-inset {chatType === 'group'
								? 'bg-indigo-50 ring-indigo-600 dark:bg-indigo-950 dark:ring-indigo-500'
								: 'ring-gray-300 hover:bg-gray-50 dark:ring-gray-700 dark:hover:bg-gray-800'}"
						>
							<input type="radio" bind:group={chatType} value="group" class="sr-only" />
							<span class="block text-sm font-medium text-gray-900 dark:text-gray-100">Group</span>
							<span class="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
								A chat for you and the selected members.
							</span>
						</label>
						<label
							class="cursor-pointer rounded-lg p-3 ring-1 ring-inset {chatType === 'private'
								? 'bg-indigo-50 ring-indigo-600 dark:bg-indigo-950 dark:ring-indigo-500'
								: 'ring-gray-300 hover:bg-gray-50 dark:ring-gray-700 dark:hover:bg-gray-800'}"
						>
							<input type="radio" bind:group={chatType} value="private" class="sr-only" />
							<span class="block text-sm font-medium text-gray-900 dark:text-gray-100">Direct</span>
							<span class="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
								A private 1-on-1 conversation.
							</span>
						</label>
					</div>
				</fieldset>

				<fieldset class="mt-4 min-w-0">
					<legend class="text-xs font-medium text-gray-700 dark:text-gray-300">
						{chatType === 'private' ? 'Recipient' : 'Members'}
					</legend>
					<Tabs.Root bind:value={memberTab}>
						<Tabs.List class="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
							<Tabs.Trigger
								value="all"
								class="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900 data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=active]:shadow-sm dark:text-gray-400 dark:hover:text-gray-100 dark:data-[state=active]:bg-gray-700 dark:data-[state=active]:text-gray-100"
							>
								All ({memberCandidates.length})
							</Tabs.Trigger>
							<Tabs.Trigger
								value="online"
								class="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900 data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=active]:shadow-sm dark:text-gray-400 dark:hover:text-gray-100 dark:data-[state=active]:bg-gray-700 dark:data-[state=active]:text-gray-100"
							>
								Online ({onlineCandidates.length})
							</Tabs.Trigger>
							<Tabs.Trigger
								value="selected"
								class="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900 data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=active]:shadow-sm dark:text-gray-400 dark:hover:text-gray-100 dark:data-[state=active]:bg-gray-700 dark:data-[state=active]:text-gray-100"
							>
								Selected ({selectedMembers.length})
							</Tabs.Trigger>
						</Tabs.List>
					</Tabs.Root>
					<div
						class="mt-1.5 max-h-44 divide-y divide-gray-100 overflow-y-auto rounded-md ring-1 ring-inset ring-gray-200 dark:divide-gray-800 dark:ring-gray-700"
					>
						{#each visibleCandidates as member (member.xmppUsername)}
							<label
								class="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
							>
								<input
									type="checkbox"
									checked={selectedMembers.includes(member.xmppUsername)}
									onchange={(event) =>
										toggleMember(member.xmppUsername, event.currentTarget.checked)}
									class="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600 dark:border-gray-600 dark:bg-gray-800"
								/>
								<span class="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">
									{`${member.firstName} ${member.lastName}`.trim()}
								</span>
								{#if onlineNicknames.has(member.xmppUsername)}
									<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"></span>
								{/if}
							</label>
						{:else}
							<p class="px-3 py-2 text-sm text-gray-500 dark:text-gray-400">
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
						class="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-gray-800"
					>
						Cancel
					</Dialog.Close>
					<button
						type="submit"
						disabled={!canSubmit || creating}
						class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{creating ? 'Creating…' : chatType === 'private' ? 'Start chat' : 'Create'}
					</button>
				</div>
			</form>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
