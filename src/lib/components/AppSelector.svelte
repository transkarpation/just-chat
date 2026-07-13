<script lang="ts">
	import { appDomainNames } from '$lib/api/config';
	import { appConfig, loadAppConfig, addCustomDomain } from '$lib/state/config.svelte';
	import { getApiErrorMessage } from '$lib/api/auth';

	// env domains first, then user-added ones (dedup against env)
	const domains = $derived([
		...appDomainNames,
		...appConfig.customDomains.filter((d) => !appDomainNames.includes(d))
	]);

	let adding = $state(false);
	let customValue = $state('');
	let error = $state('');

	async function handleChange(event: Event) {
		const domainName = (event.currentTarget as HTMLSelectElement).value;
		try {
			await loadAppConfig(domainName);
		} catch {
			// non-fatal: keep the previous config
		}
	}

	async function submitCustom() {
		error = '';
		try {
			await addCustomDomain(customValue);
			adding = false;
			customValue = '';
		} catch (err) {
			error = getApiErrorMessage(err);
		}
	}

	function cancelAdd() {
		adding = false;
		customValue = '';
		error = '';
	}
</script>

<div class="relative">
	<div class="flex items-center gap-1.5">
		{#if adding}
			<form
				class="flex items-center gap-1.5"
				onsubmit={(e) => {
					e.preventDefault();
					submitCustom();
				}}
			>
				<input
					type="text"
					bind:value={customValue}
					placeholder="domain name"
					disabled={appConfig.loading}
					aria-label="Custom domain name"
					aria-invalid={error ? 'true' : undefined}
					class="w-32 rounded-md border-0 bg-white px-2 py-1 text-sm text-gray-900 ring-1 ring-inset focus:ring-2 focus:ring-inset focus:ring-indigo-600 disabled:opacity-60 dark:bg-gray-800 dark:text-gray-100 dark:focus:ring-indigo-500 {error
						? 'ring-red-400 dark:ring-red-500'
						: 'ring-gray-300 dark:ring-gray-700'}"
				/>
				<button
					type="submit"
					disabled={appConfig.loading || !customValue.trim()}
					class="rounded-md bg-indigo-600 px-2 py-1 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{appConfig.loading ? '…' : 'Add'}
				</button>
				<button
					type="button"
					onclick={cancelAdd}
					disabled={appConfig.loading}
					class="rounded-md px-1.5 py-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
					aria-label="Cancel"
				>
					✕
				</button>
			</form>
		{:else}
			<label class="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
				<span class="sr-only">App</span>
				<select
					value={appConfig.domainName}
					onchange={handleChange}
					disabled={appConfig.loading}
					class="rounded-md border-0 bg-white py-1 pr-8 pl-2 text-sm text-gray-900 ring-1 ring-inset ring-gray-300 focus:ring-2 focus:ring-inset focus:ring-indigo-600 disabled:opacity-60 dark:bg-gray-800 dark:text-gray-100 dark:ring-gray-700 dark:focus:ring-indigo-500"
				>
					{#each domains as domainName (domainName)}
						<option value={domainName}>{domainName}</option>
					{/each}
				</select>
			</label>
			<button
				type="button"
				onclick={() => {
					adding = true;
					error = '';
				}}
				title="Add a custom domain"
				aria-label="Add a custom domain"
				class="rounded-md px-2 py-1 text-sm font-medium text-gray-600 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-gray-800"
			>
				+
			</button>
		{/if}
	</div>

	{#if error && adding}
		<p
			class="absolute top-full right-0 mt-1 whitespace-nowrap text-xs text-red-600 dark:text-red-400"
			role="alert"
		>
			{error}
		</p>
	{/if}
</div>
