import type { Request } from 'express';
import type { MediaRecord, MediaStore } from './store.js';

/**
 * All config values are read from env or passed explicitly.
 * `prefix` and `manifest` are functions because the real AWS MediaConvert
 * output path is only known after a test upload.
 */
export interface MediaConfig {
  /** AWS region (e.g. "us-east-1"). */
  region: string;
  /** S3 bucket where raw uploads are placed. */
  sourceBucket: string;
  /** S3 bucket where encoded HLS output lives (private). */
  destBucket: string;
  /**
   * CDN hostname without protocol (e.g. "cdn.myapp.com").
   * Used to build manifestUrl and to scope signed cookies.
   */
  cdnDomain: string;
  /**
   * Cookie domain string including the leading dot
   * (e.g. ".myapp.com") so the cookie is shared across subdomains.
   */
  cookieDomain: string;
  /** CloudFront key pair ID matching the private key below. */
  cfKeyPairId: string;
  /** RSA private key PEM string. Load from Secrets Manager / env, never hard-code. */
  cfPrivateKey: string;
  /** Cookie lifetime in seconds. Default: 600 (10 min). */
  cookieTtlSeconds?: number;
  /**
   * S3-compatible endpoint URL.  Set this in local dev to point at SeaweedFS.
   * When set, `forcePathStyle` is automatically enabled.
   * Remove in production (real AWS auto-discovers the endpoint).
   */
  s3Endpoint?: string;
  /**
   * Returns the S3 key prefix (folder) for one video's encoded output.
   * e.g. (id) => `videos/${id}`
   * This MUST be a function because the real AWS MediaConvert output
   * layout is only known after running a test upload.
   */
  prefix: (id: string) => string;
  /**
   * Returns the full S3 key of the master HLS playlist for a video.
   * e.g. (id) => `videos/${id}/master.m3u8`
   */
  manifest: (id: string) => string;
}

export interface MediaRouterOptions {
  config: MediaConfig;
  store: MediaStore;
  /** Extract the current user's ID from the request (throw/return null if unauthenticated). */
  getUserId: (req: Request) => string | null | Promise<string | null>;
  /** Return true if the requesting user may upload a new video. */
  canUpload: (req: Request) => boolean | Promise<boolean>;
  /** Return true if the requesting user may watch this media item. */
  canWatch: (req: Request, media: MediaRecord) => boolean | Promise<boolean>;
}
