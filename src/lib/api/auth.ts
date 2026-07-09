import { isAxiosError } from 'axios';
import { PUBLIC_APP_ID } from '$env/static/public';
import { api } from './client';

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
	const { data } = await api.post<LoginResponse>('/v1/users/login-with-email', {
		email,
		password,
		appId: PUBLIC_APP_ID
	});
	return data;
}

export function getApiErrorMessage(err: unknown): string {
	if (isAxiosError(err)) {
		const data = err.response?.data as { error?: string; message?: string } | undefined;
		return data?.error ?? data?.message ?? err.message;
	}
	return 'Something went wrong. Please try again.';
}
