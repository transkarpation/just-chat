<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { loginWithEmail, persistSession, getApiErrorMessage } from '$lib/api/auth';
	import { getMyChats } from '$lib/api/chats';
	import { setChats } from '$lib/state/chats.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import AppSelector from '$lib/components/AppSelector.svelte';
	import { appConfig } from '$lib/state/config.svelte';

	let email = $state('');
	let password = $state('');
	let remember = $state(false);
	let submitting = $state(false);
	let error = $state('');

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		submitting = true;
		try {
			const result = await loginWithEmail(email, password);
			persistSession(result, email);
			// token is now in localStorage, so the request interceptor
			// attaches the Authorization header automatically
			const chats = await getMyChats();
			setChats(chats.items);
			const redirectTo = page.url.searchParams.get('redirectTo');
			// only allow same-origin paths to avoid an open redirect
			await goto(redirectTo?.startsWith('/') ? redirectTo : '/');
		} catch (err) {
			error = getApiErrorMessage(err);
		} finally {
			submitting = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in</title>
</svelte:head>

<!-- dvh, not vh: on mobile 100vh includes the collapsed URL bar and causes
     a needless scroll even when the content fits the visible viewport -->
<div class="relative flex min-h-dvh items-center justify-center bg-gray-50 px-4 py-12 dark:bg-gray-950">
	<div class="absolute top-4 right-4 flex items-center gap-3">
		<AppSelector />
		<ThemeToggle />
	</div>
	<div class="w-full max-w-md">
		<div class="mb-8 text-center">
			{#if appConfig.config?.displayName}
				<p class="mb-2 text-sm font-semibold tracking-wide text-indigo-600 uppercase dark:text-indigo-400">
					{appConfig.config.displayName}
				</p>
			{/if}
			<h1 class="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">Sign in to your account</h1>
			<p class="mt-2 text-sm text-gray-600 dark:text-gray-400">
				Don't have an account?
				<a href="/register" class="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">Sign up</a>
			</p>
		</div>

		<div class="rounded-xl bg-white px-6 py-8 shadow-sm ring-1 ring-gray-200 sm:px-8 dark:bg-gray-900 dark:ring-gray-800">
			<form class="space-y-6" onsubmit={handleSubmit}>
				{#if error}
					<div class="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300" role="alert">
						{error}
					</div>
				{/if}

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
					<div class="flex items-center justify-between">
						<label for="password" class="block text-sm font-medium text-gray-700 dark:text-gray-300">Password</label>
						<a href="/forgot-password" class="text-sm font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300">
							Forgot password?
						</a>
					</div>
					<input
						id="password"
						type="password"
						autocomplete="current-password"
						required
						bind:value={password}
						class="mt-1.5 block w-full rounded-md border-0 bg-white px-3 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:placeholder:text-gray-500 dark:focus:ring-indigo-500"
						placeholder="••••••••"
					/>
				</div>

				<div class="flex items-center gap-2">
					<input
						id="remember"
						type="checkbox"
						bind:checked={remember}
						class="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600 dark:border-gray-600 dark:bg-gray-800"
					/>
					<label for="remember" class="text-sm text-gray-700 dark:text-gray-300">Remember me</label>
				</div>

				<button
					type="submit"
					disabled={submitting}
					class="flex w-full justify-center rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{submitting ? 'Signing in…' : 'Sign in'}
				</button>
			</form>
		</div>
	</div>
</div>
