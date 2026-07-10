<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		signUpWithEmail,
		loginWithEmail,
		persistSession,
		getApiErrorMessage
	} from '$lib/api/auth';
	import { getMyChats } from '$lib/api/chats';
	import { setChats } from '$lib/state/chats.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let firstName = $state('');
	let lastName = $state('');
	let email = $state('');
	let password = $state('');
	let submitting = $state(false);
	let error = $state('');

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		submitting = true;
		try {
			await signUpWithEmail({
				email,
				firstName: firstName.trim(),
				lastName: lastName.trim(),
				password
			});
			// the signup response has no session — log in with the same
			// credentials right away and land in the app
			const result = await loginWithEmail(email, password);
			persistSession(result, email);
			const chats = await getMyChats();
			setChats(chats.items);
			await goto('/');
		} catch (err) {
			error = getApiErrorMessage(err);
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Sign up</title>
</svelte:head>

<div class="relative flex min-h-dvh items-center justify-center bg-gray-50 px-4 py-12 dark:bg-gray-950">
	<div class="absolute top-4 right-4">
		<ThemeToggle />
	</div>
	<div class="w-full max-w-md">
		<div class="mb-8 text-center">
			<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Create your account</h1>
			<p class="mt-2 text-sm text-gray-600 dark:text-gray-400">
				Already have an account?
				<a href="/login" class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">Sign in</a>
			</p>
		</div>

		<div class="rounded-xl bg-white px-6 py-8 shadow-sm ring-1 ring-gray-200 sm:px-8 dark:bg-gray-900 dark:ring-gray-800">
			<form class="space-y-6" onsubmit={handleSubmit}>
				{#if error}
					<div class="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" role="alert">
						{error}
					</div>
				{/if}

				<div class="grid grid-cols-2 gap-4">
					<div>
						<label for="firstName" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
							First name
						</label>
						<input
							id="firstName"
							type="text"
							autocomplete="given-name"
							required
							minlength="3"
							maxlength="30"
							bind:value={firstName}
							class="mt-1.5 block w-full rounded-md border-0 bg-white px-3 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500"
							placeholder="Anna"
						/>
					</div>
					<div>
						<label for="lastName" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
							Last name
						</label>
						<input
							id="lastName"
							type="text"
							autocomplete="family-name"
							required
							minlength="3"
							maxlength="30"
							bind:value={lastName}
							class="mt-1.5 block w-full rounded-md border-0 bg-white px-3 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500"
							placeholder="Smith"
						/>
					</div>
				</div>

				<div>
					<label for="email" class="block text-sm font-medium text-gray-700 dark:text-gray-300">Email address</label>
					<input
						id="email"
						type="email"
						autocomplete="email"
						required
						bind:value={email}
						class="mt-1.5 block w-full rounded-md border-0 bg-white px-3 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500"
						placeholder="you@example.com"
					/>
				</div>

				<div>
					<label for="password" class="block text-sm font-medium text-gray-700 dark:text-gray-300">Password</label>
					<input
						id="password"
						type="password"
						autocomplete="new-password"
						required
						minlength="5"
						bind:value={password}
						class="mt-1.5 block w-full rounded-md border-0 bg-white px-3 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500"
						placeholder="••••••••"
					/>
				</div>

				<button
					type="submit"
					disabled={submitting}
					class="flex w-full justify-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{submitting ? 'Creating account…' : 'Sign up'}
				</button>
			</form>
		</div>
	</div>
</div>
