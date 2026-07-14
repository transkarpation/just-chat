<!-- Round avatar with a letter fallback: the letter shows when there is no
     image URL and also when the URL fails to load (deleted/expired uploads,
     rate-limited CDN). Failed URLs are remembered for the session so list
     re-renders don't keep re-requesting a broken image. -->
<script lang="ts" module>
	import { SvelteSet } from 'svelte/reactivity';

	const failedSrcs = new SvelteSet<string>();
</script>

<script lang="ts">
	interface Props {
		/** image URL; empty/undefined renders the letter right away */
		src?: string;
		/** fallback character — the first letter of the name/title */
		letter: string;
		/** classes for the <img> */
		imgClass: string;
		/** classes for the letter fallback */
		fallbackClass: string;
		/** lazy-load the image (long scrollable lists) */
		lazy?: boolean;
	}

	let { src, letter, imgClass, fallbackClass, lazy = false }: Props = $props();
</script>

{#if src && !failedSrcs.has(src)}
	<img
		{src}
		alt=""
		loading={lazy ? 'lazy' : undefined}
		decoding="async"
		class={imgClass}
		onerror={() => {
			if (src) failedSrcs.add(src);
		}}
	/>
{:else}
	<span class={fallbackClass}>{letter}</span>
{/if}
