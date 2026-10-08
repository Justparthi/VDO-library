/** Status events emitted by mountPlayer / SecureVideo. */
export type PlayerStatus = 'loading' | 'processing' | 'ready' | 'error';

export interface MountPlayerOptions {
  /** Base URL for the API (e.g. "https://local.myapp.test/api/media"). */
  apiBase: string;
  /** CDN origin (e.g. "https://cdn.myapp.test") — used to set allowCrossSiteCredentials. */
  cdnOrigin: string;
  /** How often to poll for processing status, ms. Default: 4000. */
  pollIntervalMs?: number;
  /** Max time to wait for processing before giving up, ms. Default: 10 min. */
  maxWaitMs?: number;
  /** Called whenever the player status changes. */
  onStatus?: (status: PlayerStatus, detail?: string) => void;
}

export interface PlayerHandle {
  /** Shaka player instance (cast to access advanced Shaka APIs). */
  player: unknown;
  /** Tear down the player and cancel all timers. */
  destroy: () => void;
}

export interface UploadVideoOptions {
  /** Base URL for the API (e.g. "https://local.myapp.test/api/media"). */
  apiBase: string;
  /** Whether the video should be protected. Default: true. */
  protected?: boolean;
  /** Progress callback (0–1). */
  onProgress?: (fraction: number) => void;
}
