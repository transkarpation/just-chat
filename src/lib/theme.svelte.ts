/**
 * Light/dark theme state. The inline script in app.html applies the stored
 * (or system) theme before first paint; this module mirrors that choice into
 * reactive state and persists toggles.
 */

const STORAGE_KEY = 'theme';

function initialDark(): boolean {
	if (typeof document === 'undefined') return false;
	// the app.html bootstrap already resolved localStorage + system preference
	return document.documentElement.classList.contains('dark');
}

export const themeState = $state({ dark: initialDark() });

export function setTheme(dark: boolean): void {
	themeState.dark = dark;
	document.documentElement.classList.toggle('dark', dark);
	localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light');
}

export function toggleTheme(): void {
	setTheme(!themeState.dark);
}
