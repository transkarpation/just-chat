export type XmppStatus =
	| 'offline'
	| 'connecting'
	| 'connect'
	| 'opening'
	| 'open'
	| 'online'
	| 'closing'
	| 'close'
	| 'disconnecting'
	| 'disconnect';

export const xmppState = $state({
	status: 'offline' as XmppStatus,
	/** room names (local part of the room JID) we have confirmed presence in */
	joinedRooms: [] as string[],
	/** room name → nicknames of occupants currently online in that room */
	occupants: {} as Record<string, string[]>,
	/** room name → nicknames currently typing there (never the own nick) */
	typing: {} as Record<string, string[]>
});
