import { api } from './client';

export interface UploadedFile {
	_id: string;
	userId: string;
	ownerKey: string;
	location: string;
	/** downscaled copy for previews (same URL as location for non-images) */
	locationPreview: string;
	originalname: string;
	/** storage name without the extension */
	filename: string;
	mimetype: string;
	size: number;
	expiresAt: number;
	isPrivate: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface UploadFilesResponse {
	success: boolean;
	results: UploadedFile[];
}

/** Upload a file to the platform storage. The field name must be `files`. */
export async function uploadFile(file: File): Promise<UploadedFile> {
	const form = new FormData();
	form.append('files', file, file.name);
	const { data } = await api.post<UploadFilesResponse>('/v1/files/', form, {
		headers: { 'Content-Type': 'multipart/form-data' }
	});
	return data.results[0];
}
