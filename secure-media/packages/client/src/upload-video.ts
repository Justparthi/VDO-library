import type { UploadVideoOptions } from './types.js';

interface CreateResponse {
  id: string;
  uploadUrl: string;
}

/**
 * Upload a video file:
 * 1. POST to /api/media to create a record and get a pre-signed PUT URL.
 * 2. PUT the file directly to S3 (using the signed URL).
 * Returns the media ID.
 */
export async function uploadVideo(
  file: File,
  opts: UploadVideoOptions,
): Promise<string> {
  const isProtected = opts.protected ?? true;

  // Step 1: create record
  const createRes = await fetch(opts.apiBase, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protected: isProtected }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create media record: ${createRes.status}`);
  }

  const { id, uploadUrl } = (await createRes.json()) as CreateResponse;

  // Step 2: PUT directly to S3
  const xhr = new XMLHttpRequest();
  await new Promise<void>((resolve, reject) => {
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', 'video/mp4');

    if (opts.onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          opts.onProgress!(e.loaded / e.total);
        }
      });
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`S3 upload failed: ${xhr.status}`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('S3 upload network error')));
    xhr.send(file);
  });

  return id;
}
