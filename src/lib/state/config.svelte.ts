import { getAppConfig, appDomainNames, defaultDomainName, type AppConfig } from '$lib/api/config';

const DOMAIN_KEY = 'appDomainName';
const CUSTOM_KEY = 'appCustomDomainNames';

function readCustomDomains(): string[] {
	if (typeof localStorage === 'undefined') return [];
	try {
		const parsed = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]');
		return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
	} catch {
		return [];
	}
}

function initialDomain(): string {
	if (typeof localStorage !== 'undefined') {
		const saved = localStorage.getItem(DOMAIN_KEY);
		if (saved) return saved;
	}
	return defaultDomainName;
}

export const appConfig = $state({
	/** currently selected domainName */
	domainName: initialDomain(),
	/** last fetched config for the selected domain */
	config: null as AppConfig | null,
	loading: false,
	/** user-added domain names, persisted in localStorage */
	customDomains: readCustomDomains()
});

function persistDomain(domainName: string) {
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem(DOMAIN_KEY, domainName);
	}
}

/** Fetch and store the config for a domain, persisting the selection. */
export async function loadAppConfig(domainName: string): Promise<void> {
	appConfig.domainName = domainName;
	persistDomain(domainName);
	appConfig.loading = true;
	try {
		appConfig.config = await getAppConfig(domainName);
	} finally {
		appConfig.loading = false;
	}
}

/**
 * Validate a user-entered domain via get-config (throws if it doesn't 200);
 * on success remember it in localStorage, select it, and store its config.
 */
export async function addCustomDomain(domainName: string): Promise<void> {
	const name = domainName.trim();
	if (!name) throw new Error('Enter a domain name');

	appConfig.loading = true;
	try {
		// getAppConfig throws on any non-2xx (e.g. 404 for an unknown domain)
		const config = await getAppConfig(name);

		if (!appDomainNames.includes(name) && !appConfig.customDomains.includes(name)) {
			appConfig.customDomains = [...appConfig.customDomains, name];
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem(CUSTOM_KEY, JSON.stringify(appConfig.customDomains));
			}
		}

		appConfig.domainName = name;
		persistDomain(name);
		appConfig.config = config;
	} finally {
		appConfig.loading = false;
	}
}

/** Display name of the selected app (empty until loaded). */
export function appDisplayName(): string {
	return appConfig.config?.displayName ?? '';
}

/** App-scoped JWT of the selected app, used as the Authorization header. */
export function appToken(): string {
	return appConfig.config?.appToken ?? '';
}

/** Backend app id of the selected app. */
export function appId(): string {
	return appConfig.config?._id ?? '';
}
