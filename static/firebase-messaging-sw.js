/**
 * Minimal service worker for Firebase Cloud Messaging. Registering it is
 * enough for getToken() to create a push subscription; background message
 * handling can be added here later.
 */
self.addEventListener('push', (event) => {
	// keep the subscription alive; the page handles foreground messages
	const payload = event.data?.json?.() ?? null;
	if (payload?.notification) {
		const { title = 'New message', body = '' } = payload.notification;
		event.waitUntil(self.registration.showNotification(title, { body }));
	}
});
