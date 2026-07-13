import PhotoSwipe from 'photoswipe';
import 'photoswipe/style.css';

export interface GalleryImage {
	/** full-size image */
	src: string;
	/** already-rendered preview, shown while the full image loads */
	msrc?: string;
	alt?: string;
}

// PhotoSwipe needs the natural size of every image, but the chat only knows
// URLs — measure them by loading and cache the result across openings
const dimensions = new Map<string, { w: number; h: number }>();

function measure(src: string): Promise<{ w: number; h: number }> {
	const cached = dimensions.get(src);
	if (cached) return Promise.resolve(cached);
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			const dims = { w: img.naturalWidth, h: img.naturalHeight };
			dimensions.set(src, dims);
			resolve(dims);
		};
		img.onerror = () => resolve({ w: 0, h: 0 });
		img.src = src;
	});
}

/** Open a PhotoSwipe gallery over the given images, starting at `index`. */
export async function openImageGallery(images: GalleryImage[], index: number): Promise<void> {
	// don't wait for the full-size image (that reads as a dead click on big
	// files) — the preview is already rendered in the chat, so it comes out
	// of the browser cache instantly and its aspect ratio is the same
	const clicked = images[index];
	if (!dimensions.has(clicked.src) && clicked.msrc) {
		await measure(clicked.msrc);
	}

	const dataSource = images.map((image) => {
		// provisional size from the preview until the real one is measured
		const dims =
			dimensions.get(image.src) ?? (image.msrc ? dimensions.get(image.msrc) : undefined);
		return {
			src: image.src,
			msrc: image.msrc,
			alt: image.alt,
			width: dims?.w ?? 0,
			height: dims?.h ?? 0
		};
	});

	const pswp = new PhotoSwipe({ dataSource, index });
	pswp.init();

	// Preload the full-size files in the background (measuring also warms the
	// browser cache) and refresh each slide once its real size is known.
	// Nearest-first from the clicked slide, not archive order: a message with
	// several attachments puts them on adjacent slides, so the ones the user
	// is about to swipe to finish first and browsing has no pauses. Limited
	// concurrency keeps the first neighbours from competing with the whole
	// room's gallery for bandwidth.
	const order = dataSource
		.map((_, i) => i)
		.filter((i) => !dimensions.has(dataSource[i].src))
		.sort((a, b) => Math.abs(a - index) - Math.abs(b - index));
	let cursor = 0;
	async function pump(): Promise<void> {
		while (cursor < order.length) {
			const i = order[cursor++];
			const item = dataSource[i];
			const { w, h } = await measure(item.src);
			item.width = w;
			item.height = h;
			if (!pswp.isDestroying) pswp.refreshSlideContent(i);
		}
	}
	for (let k = 0; k < 3; k++) pump();
}
