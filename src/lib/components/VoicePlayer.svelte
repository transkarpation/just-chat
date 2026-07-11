<script lang="ts" module>
	// only one voice message plays at a time (like Telegram)
	let pauseActive: (() => void) | null = null;
	// waveforms are expensive to decode — remember them per URL
	const waveformCache = new Map<string, { peaks: number[]; duration: number }>();
</script>

<script lang="ts">
	import { onDestroy, onMount } from 'svelte';

	let { src, mine = false }: { src: string; mine?: boolean } = $props();

	const BAR_COUNT = 44;
	// flat placeholder until the real waveform is decoded (or if decoding
	// isn't possible, e.g. Safari can't decode webm/opus — still playable)
	let peaks = $state<number[]>(Array(BAR_COUNT).fill(0.25));
	let duration = $state(0);
	let current = $state(0);
	let playing = $state(false);
	let audio: HTMLAudioElement | null = null;
	let raf = 0;

	onMount(() => {
		void loadWaveform();
	});

	async function loadWaveform() {
		const cached = waveformCache.get(src);
		if (cached) {
			peaks = cached.peaks;
			duration = cached.duration;
			return;
		}
		try {
			const response = await fetch(src);
			const encoded = await response.arrayBuffer();
			const ctx = new AudioContext();
			try {
				// decoding also yields the true duration — MediaRecorder blobs
				// often report Infinity through the media element
				const decoded = await ctx.decodeAudioData(encoded);
				duration = decoded.duration;
				const data = decoded.getChannelData(0);
				const bucket = Math.max(1, Math.floor(data.length / BAR_COUNT));
				const raw: number[] = [];
				for (let i = 0; i < BAR_COUNT; i++) {
					const start = i * bucket;
					const end = Math.min(start + bucket, data.length);
					let sum = 0;
					let count = 0;
					for (let j = start; j < end; j += 16) {
						sum += Math.abs(data[j]);
						count += 1;
					}
					raw.push(count > 0 ? sum / count : 0);
				}
				const max = Math.max(...raw, 1e-6);
				peaks = raw.map((v) => Math.max(0.15, Math.min(1, v / max)));
				waveformCache.set(src, { peaks: [...peaks], duration });
			} finally {
				void ctx.close();
			}
		} catch (err) {
			console.error('waveform decode failed:', err);
		}
	}

	function progressLoop() {
		raf = requestAnimationFrame(() => {
			if (audio) current = audio.currentTime;
			if (playing) progressLoop();
		});
	}

	function ensureAudio(): HTMLAudioElement {
		if (!audio) {
			audio = new Audio(src);
			audio.onplay = () => {
				playing = true;
				progressLoop();
			};
			audio.onpause = () => {
				playing = false;
				cancelAnimationFrame(raf);
				if (audio) current = audio.currentTime;
			};
			audio.onended = () => {
				playing = false;
				current = 0;
				cancelAnimationFrame(raf);
			};
		}
		return audio;
	}

	function toggle() {
		const el = ensureAudio();
		if (el.paused) {
			pauseActive?.();
			pauseActive = () => el.pause();
			void el.play();
		} else {
			el.pause();
		}
	}

	function seek(event: MouseEvent) {
		if (!duration) return;
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
		const el = ensureAudio();
		el.currentTime = ratio * duration;
		current = el.currentTime;
	}

	onDestroy(() => {
		audio?.pause();
		cancelAnimationFrame(raf);
	});

	const progress = $derived(duration > 0 ? current / duration : 0);

	function formatTime(total: number): string {
		const minutes = Math.floor(total / 60);
		const seconds = Math.floor(total % 60);
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}
</script>

<div class="flex w-full items-center gap-2.5 py-1">
	<button
		type="button"
		onclick={toggle}
		title={playing ? 'Pause' : 'Play'}
		aria-label={playing ? 'Pause' : 'Play'}
		class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full shadow-sm {mine
			? 'bg-white text-indigo-600 hover:bg-indigo-50'
			: 'bg-indigo-600 text-white hover:bg-indigo-500'}"
	>
		{#if playing}
			<svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
				<rect x="6" y="4" width="4" height="16" rx="1"></rect>
				<rect x="14" y="4" width="4" height="16" rx="1"></rect>
			</svg>
		{:else}
			<svg class="ml-0.5 h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
				<polygon points="6 3 21 12 6 21 6 3"></polygon>
			</svg>
		{/if}
	</button>
	<div class="flex min-w-0 flex-1 flex-col gap-0.5">
		<button
			type="button"
			onclick={seek}
			aria-label="Seek"
			class="flex h-8 w-full cursor-pointer items-center gap-[2px]"
		>
			{#each peaks as peak, i (i)}
				<span
					class="min-w-[2px] flex-1 rounded-full {(i + 0.5) / peaks.length <= progress
						? mine
							? 'bg-white'
							: 'bg-indigo-600 dark:bg-indigo-400'
						: mine
							? 'bg-white/40'
							: 'bg-gray-300 dark:bg-gray-600'}"
					style="height: {Math.round(peak * 100)}%"
				></span>
			{/each}
		</button>
		<span
			class="text-xs tabular-nums {mine ? 'text-indigo-200' : 'text-gray-500 dark:text-gray-400'}"
		>
			{current > 0 ? `${formatTime(current)} / ${formatTime(duration)}` : formatTime(duration)}
		</span>
	</div>
</div>
