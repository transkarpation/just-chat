import { initializeApp, getApps, getApp, type FirebaseOptions } from 'firebase/app';
import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import { appConfig, ensureAppConfig } from '$lib/state/config.svelte';

/**
 * Get the FCM device token for push notifications and print it to the
 * console. Uses the Firebase web config of the selected app (from
 * get-config's firebaseWebConfigString). No-ops with a warning when the
 * app has no Firebase config or the browser doesn't support push.
 */
export async function logDeviceToken(): Promise<string | null> {
	let raw: string | undefined;
	try {
		raw = (await ensureAppConfig()).firebaseWebConfigString;
	} catch {
		console.warn('[push] app config is not available — cannot get a device token');
		return null;
	}
	if (!raw) {
		console.warn(
			`[push] app "${appConfig.domainName}" has no firebaseWebConfigString — cannot get a device token`
		);
		return null;
	}

	let options: FirebaseOptions;
	try {
		options = JSON.parse(raw);
	} catch {
		console.warn('[push] firebaseWebConfigString is not valid JSON');
		return null;
	}

	if (!(await isSupported())) {
		console.warn('[push] Firebase messaging is not supported in this browser');
		return null;
	}
	if (Notification.permission !== 'granted') {
		console.warn('[push] notification permission not granted — cannot get a device token');
		return null;
	}

	try {
		// one Firebase app per Ethora app id, so switching apps re-inits cleanly
		const name = `push-${options.appId ?? appConfig.domainName}`;
		const app = getApps().some((a) => a.name === name)
			? getApp(name)
			: initializeApp(options, name);

		const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
		await navigator.serviceWorker.ready;

		const token = await getToken(getMessaging(app), {
			serviceWorkerRegistration: registration
		});
		console.log('[push] FCM device token:', token);
		return token;
	} catch (err) {
		console.error('[push] failed to get device token:', err);
		return null;
	}
}
