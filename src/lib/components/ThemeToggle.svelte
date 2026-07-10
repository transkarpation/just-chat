<script lang="ts">
	import { themeState, toggleTheme } from '$lib/theme.svelte';
</script>

<button
	type="button"
	onclick={toggleTheme}
	title={themeState.dark ? 'Switch to light theme' : 'Switch to dark theme'}
	aria-label={themeState.dark ? 'Switch to light theme' : 'Switch to dark theme'}
	class="rounded-md bg-white px-2.5 py-1.5 text-sm text-gray-700 ring-1 ring-inset ring-gray-300 hover:bg-gray-50 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-gray-800"
>
	{themeState.dark ? '☀️' : '🌙'}
</button>
