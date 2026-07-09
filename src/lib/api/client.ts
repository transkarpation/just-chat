import axios from 'axios';
import { goto } from '$app/navigation';
import { PUBLIC_API_BASE_URL } from '$env/static/public';

export const api = axios.create({
	baseURL: PUBLIC_API_BASE_URL,
	headers: {
		'Content-Type': 'application/json'
	}
});

api.interceptors.request.use((config) => {
	const token = localStorage.getItem('token');
	if (token) config.headers.Authorization = `Bearer ${token}`;
	return config;
});

api.interceptors.response.use(
	(res) => res,
	(err) => {
		// 401 on the login request itself means bad credentials, not an expired
		// session — let the form show the error instead of redirecting.
		const isLoginRequest = err.config?.url?.includes('/users/login-with-email');
		if (err.response?.status === 401 && !isLoginRequest) {
			localStorage.removeItem('token');
			localStorage.removeItem('refreshToken');
			goto('/login');
		}
		return Promise.reject(err);
	}
);
