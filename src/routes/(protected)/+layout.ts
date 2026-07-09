import { redirect } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = ({ url }) => {
	const token = localStorage.getItem('token');
	if (!token) {
		// keep the query string too, so shared links like /?roomId=… survive login
		redirect(307, `/login?redirectTo=${encodeURIComponent(url.pathname + url.search)}`);
	}
	return {};
};
