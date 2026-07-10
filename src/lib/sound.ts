let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
	if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
	ctx ??= new AudioContext();
	return ctx;
}

/**
 * Short two-note chime, synthesized so no audio asset is needed. Browsers
 * keep the AudioContext suspended until the user interacts with the page —
 * before that the sound is silently skipped.
 */
export async function playMentionSound(): Promise<void> {
	const ac = audioContext();
	if (!ac) return;
	if (ac.state === 'suspended') {
		try {
			await ac.resume();
		} catch {
			return;
		}
	}
	if (ac.state !== 'running') return;
	const now = ac.currentTime;
	// A5 then D6 — a quick rising "you were pinged" chime
	const notes: [frequency: number, offset: number][] = [
		[880, 0],
		[1174.66, 0.09]
	];
	for (const [frequency, offset] of notes) {
		const osc = ac.createOscillator();
		const gain = ac.createGain();
		osc.type = 'sine';
		osc.frequency.value = frequency;
		gain.gain.setValueAtTime(0, now + offset);
		gain.gain.linearRampToValueAtTime(0.18, now + offset + 0.015);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.35);
		osc.connect(gain).connect(ac.destination);
		osc.start(now + offset);
		osc.stop(now + offset + 0.4);
	}
}
