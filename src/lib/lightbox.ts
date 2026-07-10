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
	// know the clicked image's real size before opening so the zoom
	// animation starts with the correct aspect ratio
	await measure(images[index].src);

	const dataSource = images.map((image) => {
		const dims = dimensions.get(image.src);
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

	// the other images are measured in the background; refresh their slides
	// once the size is known so swiping to them renders correctly
	dataSource.forEach((item, i) => {
		if (item.width) return;
		measure(item.src).then(({ w, h }) => {
			item.width = w;
			item.height = h;
			if (!pswp.isDestroying) pswp.refreshSlideContent(i);
		});
	});
}
