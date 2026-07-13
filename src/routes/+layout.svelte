<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { PUBLIC_APP_ENV } from '$env/static/public';

	let { children } = $props();

	const isDev = PUBLIC_APP_ENV === 'dev';
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{#if isDev}
	<div
		class="pointer-events-none fixed bottom-2 left-2 z-50 rounded bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white shadow"
	>
		DEV
	</div>
{/if}

{@render children()}
