import { api } from './client';
import type { LoginUser } from './auth';

/**
 * PUT /v1/users takes multipart/form-data. Every field is optional —
 * omitted fields stay unchanged on the server. Limits mirror the backend's
 * Joi schema: sending a field that violates them returns a 422.
 */
export interface UpdateProfilePayload {
	/** profile picture; replaces the current profileImage */
	file?: File;
	/** 3–30 chars */
	firstName?: string;
	/** 3–30 chars */
	lastName?: string;
	/** min 5 chars */
	phone?: string;
	/** 3–30 chars */
	company?: string;
	/** 3–30 chars */
	addressLine1?: string;
	/** 3–30 chars */
	addressLine2?: string;
	/** 3–30 chars */
	street?: string;
	/** 3–30 chars */
	city?: string;
	/** 3–30 chars — note: 2-letter ISO codes are rejected by the min(3) rule */
	country?: string;
	/** 3–30 chars */
	zip?: string;
	/** 5–300 chars, or '' to clear */
	description?: string;
	isAssetsOpen?: boolean;
	isProfileOpen?: boolean;
	/** URL of an already-uploaded image, or '' to clear the picture */
	profileImage?: string;
}

export interface UpdateUserResponse {
	user: LoginUser;
}

/** Update the current user's own profile (fields and/or picture in one call). */
export async function updateProfile(payload: UpdateProfilePayload): Promise<UpdateUserResponse> {
	const { file, ...fields } = payload;
	const form = new FormData();
	if (file) form.append('file', file, file.name);
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		form.append(key, typeof value === 'boolean' ? String(value) : value);
	}
	const { data } = await api.put<UpdateUserResponse>('/v1/users', form, {
		// override the client's default application/json so axios sets the
		// multipart boundary itself
		headers: { 'Content-Type': 'multipart/form-data' }
	});
	return data;
}
