<script lang="ts">
	/**
	 * Chat-type icon (public globe / group people) with its own tooltip.
	 * Inline SVG instead of the material-icons ligature, so the raw word
	 * ("public") can never flash while the icon font loads.
	 *
	 * The tooltip shows on hover; in interactive mode it also toggles on
	 * click, which covers mobile taps where there is no hover. Pass
	 * interactive={false} when the icon sits inside another interactive
	 * element (e.g. a chat-list row button) — a nested <button> would be
	 * invalid HTML there, so it renders a plain span with hover-only tooltip.
	 */
	let { type, interactive = true }: { type: 'public' | 'group'; interactive?: boolean } = $props();

	const label = $derived(type === 'public' ? 'Public chat' : 'Group chat');
	let open = $state(false);
</script>

{#snippet icon()}
	<svg viewBox="0 0 24 24" fill="currentColor" class="h-[18px] w-[18px]" aria-hidden="true">
		{#if type === 'public'}
			<path
				d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
			/>
		{:else}
			<path
				d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"
			/>
		{/if}
	</svg>
{/snippet}

<span class="group/cti relative inline-flex shrink-0">
	{#if interactive}
		<button
			type="button"
			aria-label={label}
			onclick={() => (open = !open)}
			onblur={() => (open = false)}
			class="inline-flex cursor-default text-gray-400 dark:text-gray-500"
		>
			{@render icon()}
		</button>
	{:else}
		<span role="img" aria-label={label} class="inline-flex text-gray-400 dark:text-gray-500">
			{@render icon()}
		</span>
	{/if}
	<span
		role="tooltip"
		class="pointer-events-none absolute top-full left-1/2 z-30 mt-1.5 -translate-x-1/2 rounded-md bg-gray-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-white shadow-lg transition-opacity duration-100 group-hover/cti:opacity-100 dark:bg-gray-700 {open
			? 'opacity-100'
			: 'opacity-0'}"
	>
		{label}
	</span>
</span>
