import { getUserByXmppUsername, type UserRecord } from '$lib/api/users';

/**
 * Cache of user lookups for message senders who are not in the open chat's
 * member list (removed from the chat, or their account is gone).
 * `null` = the backend answered 404, i.e. the account no longer exists.
 * Absent key = not looked up yet.
 */
export const userLookupState = $state({
	records: {} as Record<string, UserRecord | null>
});

const inFlight = new Set<string>();

/**
 * Fire-and-forget lookup: resolves the user into userLookupState.records,
 * where the UI picks it up reactively. Network errors are not cached, so a
 * later call retries.
 */
export function lookupUser(xmppUsername: string): void {
	if (xmppUsername in userLookupState.records || inFlight.has(xmppUsername)) return;
	inFlight.add(xmppUsername);
	getUserByXmppUsername(xmppUsername)
		.then((record) => {
			userLookupState.records[xmppUsername] = record;
		})
		.catch((err) => {
			console.error(`user lookup failed for ${xmppUsername}:`, err);
		})
		.finally(() => {
			inFlight.delete(xmppUsername);
		});
}

export function clearUserLookups(): void {
	userLookupState.records = {};
	inFlight.clear();
}
