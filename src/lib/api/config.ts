import { PUBLIC_APP_DOMAIN_NAMES, PUBLIC_APP_DOMAIN_NAME } from '$env/static/public';
import { api } from './client';

export interface SystemChatAccount {
	jid: string;
}

export interface AvailableMenuItems {
	chats: boolean;
	profile: boolean;
	settings: boolean;
}

export interface AiBotConfig {
	trigger: string;
	ragTags: string[];
	widgetPublicEnabled: boolean;
	totalSiteSourceSize: number;
	userId: string;
	savedAgentId: string;
	chatId: string;
	status: string;
	greetingMessage: string;
	prompt: string;
	isRAG: boolean;
}

export interface BroadcastSender {
	name: string;
	photoUrl: string;
}

export interface DefaultRoom {
	chatId: string;
	title: string;
	jid: string;
	pinned: boolean;
	creator: string;
	_id: string;
}

/** Shape of `result` from GET /v1/apps/get-config. */
export interface AppConfig {
	systemChatAccount: SystemChatAccount;
	availableMenuItems: AvailableMenuItems;
	aiBot: AiBotConfig;
	broadcastSender: BroadcastSender;
	_id: string;
	displayName: string;
	domainName: string;
	creatorId: string;
	bundleId: string;
	primaryColor: string;
	coinSymbol: string;
	coinName: string;
	logoImage: string;
	sublogoImage: string;
	appTagline: string;
	defaultAccessProfileOpen: boolean;
	defaultAccessAssetsOpen: boolean;
	usersCanFree: boolean;
	parentAppId: string;
	isAllowedNewAppCreate: boolean;
	isBaseApp: boolean;
	firebaseWebConfigString: string;
	googleServicesJson: string;
	googleServiceInfoPlist: string;
	REACT_APP_STRIPE_PUBLISHABLE_KEY: string;
	REACT_APP_STRIPE_SECRET_KEY: string;
	signonOptions: string[];
	afterLoginPage: string;
	allowUsersToCreateRooms: boolean;
	defaultBotInstanceId: string;
	status: string;
	archivedAt: string | null;
	archivedBy: string | null;
	archiveReason: string;
	purgedAt: string | null;
	appTokens: unknown[];
	defaultRooms: DefaultRoom[];
	createdAt: string;
	updatedAt: string;
	__v: number;
	/** App-scoped JWT ("JWT <token>"), used as the Authorization for app-level requests. */
	appToken: string;
}

export interface GetAppConfigResponse {
	result: AppConfig;
}

/** Selectable domain names, defined in env (comma-separated). */
export const appDomainNames = PUBLIC_APP_DOMAIN_NAMES.split(',')
	.map((name) => name.trim())
	.filter(Boolean);

/** Domain selected by default (falls back to the first configured one). */
export const defaultDomainName = PUBLIC_APP_DOMAIN_NAME || appDomainNames[0] || '';

/** Fetch the app config for a domain (public, no auth required). */
export async function getAppConfig(domainName: string): Promise<AppConfig> {
	const { data } = await api.get<GetAppConfigResponse>('/v1/apps/get-config', {
		params: { domainName }
	});
	return data.result;
}
