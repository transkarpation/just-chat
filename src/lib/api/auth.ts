import { isAxiosError } from 'axios';
import { api } from './client';
import { ensureAppConfig } from '$lib/state/config.svelte';

export interface LoginUser {
	_id: string;
	firstName: string;
	lastName: string;
	email?: string;
	appId: string;
	profileImage?: string;
	description?: string;
	xmppUsername: string;
	xmppPassword: string;
}

export interface LoginResponse {
	success: boolean;
	token: string;
	refreshToken?: string;
	user: LoginUser;
}

export async function loginWithEmail(email: string, password: string): Promise<LoginResponse> {
	const config = await ensureAppConfig();
	const { data } = await api.post<LoginResponse>(
		'/v2/users/login-with-email',
		{ email, password, appId: config._id },
		{ headers: { Authorization: config.appToken } }
	);
	return data;
}

/**
 * Register a new user (POST /v2/users/sign-up-with-email/). The response
 * carries no session — log in with the same credentials right after (works
 * immediately, email verification is not a gate on this backend).
 */
export async function signUpWithEmail(input: {
	email: string;
	firstName: string;
	lastName: string;
	password: string;
}): Promise<void> {
	const config = await ensureAppConfig();
	await api.post(
		'/v2/users/sign-up-with-email/',
		{ ...input, appId: config._id },
		{ headers: { Authorization: config.appToken } }
	);
}

/** Store everything the app needs from a login response in localStorage. */
export function persistSession(result: LoginResponse, fallbackEmail: string): void {
	localStorage.setItem('token', result.token);
	if (result.refreshToken) {
		localStorage.setItem('refreshToken', result.refreshToken);
	}
	// XMPP credentials — needed to connect to chat rooms
	localStorage.setItem('xmppUsername', result.user.xmppUsername);
	localStorage.setItem('xmppPassword', result.user.xmppPassword);
	localStorage.setItem('userEmail', result.user.email ?? fallbackEmail);
	localStorage.setItem('userId', result.user._id);
	localStorage.setItem('firstName', result.user.firstName ?? '');
	localStorage.setItem('lastName', result.user.lastName ?? '');
	localStorage.setItem('profileImage', result.user.profileImage ?? '');
	localStorage.setItem('description', result.user.description ?? '');
}

export function getApiErrorMessage(err: unknown): string {
	if (isAxiosError(err)) {
		const data = err.response?.data as { error?: string; message?: string } | undefined;
		return data?.error ?? data?.message ?? err.message;
	}
	return 'Something went wrong. Please try again.';
}
