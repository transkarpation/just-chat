<script lang="ts">
	import { Dialog, Tabs } from 'bits-ui';
	import {
		addChatMembers,
		removeChatMembers,
		type Chat,
		type ChatMember
	} from '$lib/api/chats';
	import { getApiErrorMessage } from '$lib/api/auth';
	import { chatsState } from '$lib/state/chats.svelte';
	import { xmppState } from '$lib/state/xmpp.svelte';

	let {
		open = $bindable(false),
		chat,
		myNickname
	}: {
		open?: boolean;
		/** the chat being managed — its members array is updated in place on
		 * success, so the rest of the UI (header counter etc.) follows along */
		chat: Chat;
		/** own xmppUsername — the owner cannot remove themselves here */
		myNickname: string;
	} = $props();

	let error = $state('');
	let selectedMembers = $state<string[]>([]);
	let adding = $state(false);
	/** xmppUsername a remove request is in flight for, null when idle */
	let removing = $state<string | null>(null);
	let memberTab = $state('all');
	let search = $state('');

	const busy = $derived(adding || removing !== null);

	// start every open from a clean slate
	$effect(() => {
		if (open) {
			error = '';
			memberTab = 'all';
			selectedMembers = [];
			search = '';
		}
	});

	function memberName(member: ChatMember): string {
		return `${member.firstName} ${member.lastName}`.trim();
	}

	function toggleMember(xmppUsername: string, checked: boolean) {
		selectedMembers = checked
			? [...selectedMembers, xmppUsername]
			: selectedMembers.filter((u) => u !== xmppUsername);
	}

	// people seen across my other chats who are not in this one yet
	const candidates = $derived.by(() => {
		const present = new Set(chat.members.map((m) => m.xmppUsername));
		const seen = new Map<string, ChatMember>();
		for (const item of chatsState.items) {
			for (const member of item.members) {
				if (member.xmppUsername === myNickname || present.has(member.xmppUsername)) continue;
				if (!seen.has(member.xmppUsername)) seen.set(member.xmppUsername, member);
			}
		}
		return [...seen.values()].sort((a, b) => memberName(a).localeCompare(memberName(b)));
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
		candidates.filter((m) => onlineNicknames.has(m.xmppUsername))
	);
	const visibleCandidates = $derived.by(() => {
		if (memberTab === 'online') return onlineCandidates;
		if (memberTab === 'selected') {
			return candidates.filter((m) => selectedMembers.includes(m.xmppUsername));
		}
		const query = search.trim().toLowerCase();
		if (!query) return candidates;
		return candidates.filter((m) => memberName(m).toLowerCase().includes(query));
	});

	async function addSelected() {
		if (selectedMembers.length === 0 || busy) return;
		adding = true;
		error = '';
		try {
			await addChatMembers(chat.name, selectedMembers);
			// reuse the candidate member objects — unlike the response they
			// carry profileImage
			const added = candidates.filter((m) => selectedMembers.includes(m.xmppUsername));
			chat.members = [...chat.members, ...added];
			selectedMembers = [];
			memberTab = 'all';
		} catch (err) {
			error = getApiErrorMessage(err);
		} finally {
			adding = false;
		}
	}

	async function remove(member: ChatMember) {
		if (busy) return;
		removing = member.xmppUsername;
		error = '';
		try {
			await removeChatMembers(chat.name, [member.xmppUsername]);
			// the backend drops the membership asynchronously (~45s in
			// /chats/my) — a refetch would resurrect it, so update locally
			chat.members = chat.members.filter((m) => m.xmppUsername !== member.xmppUsername);
		} catch (err) {
			error = getApiErrorMessage(err);
		} finally {
			removing = null;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-40 bg-gray-900/40 dark:bg-black/60" />
		<Dialog.Content
			class="fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900 dark:ring-1 dark:ring-gray-800"
		>
			<Dialog.Title class="text-base font-semibold text-gray-900 dark:text-gray-100">Manage members</Dialog.Title>

			{#if error}
				<p class="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>
			{/if}

			<h4 class="mt-4 text-xs font-medium text-gray-700 dark:text-gray-300">
				Members ({chat.members.length})
			</h4>
			<ul
				class="mt-1.5 max-h-44 divide-y divide-gray-100 overflow-y-auto rounded-md ring-1 ring-inset ring-gray-200 dark:divide-gray-800 dark:ring-gray-700"
			>
				{#each chat.members as member (member.xmppUsername)}
					{@const mine = member.xmppUsername === myNickname}
					<li class="flex items-center gap-2.5 px-3 py-2 text-sm">
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
								{memberName(member).charAt(0).toUpperCase()}
							</div>
						{/if}
						<span class="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{memberName(member)}</span>
						{#if member._id === chat.createdBy}
							<span
								class="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
							>
								owner
							</span>
						{/if}
						{#if onlineNicknames.has(member.xmppUsername)}
							<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500"></span>
						{/if}
						{#if !mine}
							<button
								type="button"
								onclick={() => remove(member)}
								disabled={busy}
								class="shrink-0 rounded-md bg-white px-2 py-0.5 text-xs font-medium text-red-600 ring-1 ring-inset ring-red-200 hover:bg-red-50 disabled:opacity-50 dark:bg-gray-900 dark:text-red-400 dark:ring-red-900 dark:hover:bg-red-950"
							>
								{removing === member.xmppUsername ? 'Removing…' : 'Remove'}
							</button>
						{/if}
					</li>
				{/each}
			</ul>

			<fieldset class="mt-4 min-w-0">
				<legend class="text-xs font-medium text-gray-700 dark:text-gray-300">Add people</legend>
				<Tabs.Root bind:value={memberTab}>
					<Tabs.List class="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-800">
						<Tabs.Trigger
							value="all"
							class="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900 data-[state=active]:bg-white data-[state=active]:text-gray-900 data-[state=active]:shadow-sm dark:text-gray-400 dark:hover:text-gray-100 dark:data-[state=active]:bg-gray-700 dark:data-[state=active]:text-gray-100"
						>
							All ({candidates.length})
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
									{memberName(member).charAt(0).toUpperCase()}
								</div>
							{/if}
							<span class="min-w-0 flex-1 truncate text-gray-900 dark:text-gray-100">{memberName(member)}</span>
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
									: search.trim()
										? 'No one matches your search.'
										: 'Nobody left to add — everyone you know from your chats is already here.'}
						</p>
					{/each}
				</div>
				{#if memberTab === 'all'}
					<input
						type="search"
						bind:value={search}
						placeholder="Search by name…"
						class="mt-1.5 block w-full rounded-md border-0 bg-white px-3 py-1.5 text-sm text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500"
					/>
				{/if}
			</fieldset>

			<div class="mt-4 flex justify-end gap-2">
				<Dialog.Close
					class="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-gray-800"
				>
					Close
				</Dialog.Close>
				<button
					type="button"
					onclick={addSelected}
					disabled={selectedMembers.length === 0 || busy}
					class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{adding
						? 'Adding…'
						: `Add${selectedMembers.length > 0 ? ` (${selectedMembers.length})` : ''}`}
				</button>
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
