<script lang="ts">
	import { onMount } from 'svelte';
	import { getApiErrorMessage } from '$lib/api/auth';
	import { updateProfile } from '$lib/api/users';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let firstName = $state('');
	let lastName = $state('');
	let description = $state('');
	let email = $state('');
	let profileImage = $state('');
	let uploading = $state(false);
	let savingName = $state(false);
	let error = $state('');
	let saved = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	onMount(() => {
		firstName = localStorage.getItem('firstName') ?? '';
		lastName = localStorage.getItem('lastName') ?? '';
		description = localStorage.getItem('description') ?? '';
		email = localStorage.getItem('userEmail') ?? '';
		profileImage = localStorage.getItem('profileImage') ?? '';
	});

	function applyUser(user: {
		firstName: string;
		lastName: string;
		profileImage?: string;
		description?: string;
	}) {
		firstName = user.firstName ?? '';
		lastName = user.lastName ?? '';
		profileImage = user.profileImage ?? '';
		description = user.description ?? '';
		localStorage.setItem('firstName', firstName);
		localStorage.setItem('lastName', lastName);
		localStorage.setItem('profileImage', profileImage);
		localStorage.setItem('description', description);
		saved = true;
		setTimeout(() => (saved = false), 2500);
	}

	async function onFileChange(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		uploading = true;
		error = '';
		saved = false;
		try {
			// one multipart call: the picture goes in the `file` field
			const { user } = await updateProfile({ file });
			applyUser(user);
		} catch (err) {
			error = getApiErrorMessage(err);
		} finally {
			uploading = false;
			input.value = ''; // allow re-selecting the same file
		}
	}

	// backend Joi schema: names must be 3–30 chars when sent,
	// description 5–300 chars or '' (empty clears it)
	const validLength = (value: string) => value.length >= 3 && value.length <= 30;
	const nameValid = $derived(
		validLength(firstName.trim()) && (lastName.trim() === '' || validLength(lastName.trim()))
	);
	const descriptionValid = $derived.by(() => {
		const trimmed = description.trim();
		return trimmed === '' || (trimmed.length >= 5 && trimmed.length <= 300);
	});

	async function saveProfile(event: SubmitEvent) {
		event.preventDefault();
		if (savingName || !nameValid || !descriptionValid) return;
		savingName = true;
		error = '';
		saved = false;
		try {
			const trimmedLast = lastName.trim();
			const { user } = await updateProfile({
				firstName: firstName.trim(),
				// an empty string would fail the min(3) rule — omit it instead
				...(trimmedLast ? { lastName: trimmedLast } : {}),
				// '' is allowed here and clears the bio
				description: description.trim()
			});
			applyUser(user);
		} catch (err) {
			error = getApiErrorMessage(err);
		} finally {
			savingName = false;
		}
	}
</script>

<svelte:head>
	<title>Profile</title>
</svelte:head>

<div class="min-h-screen bg-gray-50 dark:bg-gray-950">
	<header class="border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
		<div class="mx-auto flex max-w-2xl items-center justify-between px-4 py-4 sm:px-6">
			<h1 class="text-lg font-semibold text-gray-900 dark:text-gray-100">Profile</h1>
			<div class="flex items-center gap-4">
				<ThemeToggle />
				<a href="/" class="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">
					← Back to chats
				</a>
			</div>
		</div>
	</header>

	<main class="mx-auto max-w-2xl px-4 py-10 sm:px-6">
		<div class="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-200 dark:bg-gray-900 dark:ring-gray-800">
			<div class="flex items-center gap-5">
				{#if profileImage}
					<img
						src={profileImage}
						alt="Profile"
						class="h-24 w-24 shrink-0 rounded-full object-cover ring-1 ring-gray-200 dark:ring-gray-700"
					/>
				{:else}
					<div
						class="flex h-24 w-24 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-3xl font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
					>
						{(firstName || email).charAt(0).toUpperCase()}
					</div>
				{/if}

				<div class="min-w-0">
					<p class="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">
						{`${firstName} ${lastName}`.trim() || 'Unnamed user'}
					</p>
					<p class="truncate text-sm text-gray-500 dark:text-gray-400">{email}</p>

					<div class="mt-3 flex items-center gap-3">
						<input
							type="file"
							accept="image/*"
							class="hidden"
							bind:this={fileInput}
							onchange={onFileChange}
						/>
						<button
							type="button"
							onclick={() => fileInput?.click()}
							disabled={uploading}
							class="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{uploading ? 'Uploading…' : profileImage ? 'Change photo' : 'Upload photo'}
						</button>
						{#if saved}
							<span class="text-sm font-medium text-green-600 dark:text-green-400">Saved ✓</span>
						{/if}
					</div>
				</div>
			</div>

			<form class="mt-6 border-t border-gray-100 pt-6 dark:border-gray-800" onsubmit={saveProfile}>
				<div class="grid gap-4 sm:grid-cols-2">
					<div>
						<label for="firstName" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
							First name
						</label>
						<input
							id="firstName"
							type="text"
							bind:value={firstName}
							minlength="3"
							maxlength="30"
							class="mt-1.5 block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500"
						/>
					</div>
					<div>
						<label for="lastName" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
							Last name
						</label>
						<input
							id="lastName"
							type="text"
							bind:value={lastName}
							minlength="3"
							maxlength="30"
							class="mt-1.5 block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500"
						/>
					</div>
				</div>
				<div class="mt-4">
					<label for="description" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
						About you
					</label>
					<textarea
						id="description"
						bind:value={description}
						rows="3"
						maxlength="300"
						placeholder="A short bio shown on your profile…"
						class="mt-1.5 block w-full resize-y rounded-md border-0 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm ring-1 ring-inset dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500 {descriptionValid
							? 'ring-gray-300 focus:ring-indigo-600 dark:ring-gray-700 dark:focus:ring-indigo-500'
							: 'ring-red-300 focus:ring-red-500 dark:ring-red-900'} placeholder:text-gray-400 focus:ring-2 focus:ring-inset"
					></textarea>
					<p class="mt-1 text-xs {descriptionValid ? 'text-gray-400 dark:text-gray-500' : 'text-red-600 dark:text-red-400'}">
						{description.trim().length}/300 — 5 characters minimum, or leave empty to clear.
					</p>
				</div>

				<div class="mt-4 flex items-center justify-between gap-4">
					<p class="text-xs text-gray-500 dark:text-gray-400">Names must be 3–30 characters.</p>
					<button
						type="submit"
						disabled={savingName || !nameValid || !descriptionValid}
						class="shrink-0 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{savingName ? 'Saving…' : 'Save changes'}
					</button>
				</div>
			</form>

			{#if error}
				<p class="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" role="alert">{error}</p>
			{/if}
		</div>
	</main>
</div>
