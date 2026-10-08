import type { MountPlayerOptions, PlayerHandle, PlayerStatus } from './types.js';

const DEFAULT_POLL_MS = 4_000;
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1_000;
// Refresh cookies when ~80% of their lifetime has elapsed
const REFRESH_FRACTION = 0.8;

interface PlaybackResponse {
  status: 'ready' | 'processing';
  manifestUrl?: string;
  expiresAt?: number;
}

async function fetchPlayback(
  apiBase: string,
  mediaId: string,
): Promise<PlaybackResponse> {
  const res = await fetch(`${apiBase}/${mediaId}/playback`, {
    credentials: 'include',
  });
  if (res.status === 404) throw new Error('Media not found');
  if (res.status === 403) throw new Error('Access denied');
  if (res.status === 202) return { status: 'processing' };
  if (!res.ok) throw new Error(`Playback request failed: ${res.status}`);
  return res.json() as Promise<PlaybackResponse>;
}

// Minimal shape we need from shaka.Player — avoids depending on shaka's
// full type definitions, which differ between CJS/ESM entrypoints.
interface ShakaPlayerLike {
  load(url: string): Promise<void>;
  destroy(): Promise<void>;
  retryStreaming(): void;
  addEventListener(event: string, cb: (e: unknown) => void): void;
  getNetworkingEngine(): {
    registerRequestFilter(
      fn: (type: unknown, req: Record<string, unknown>) => void,
    ): void;
  };
}

interface ShakaModule {
  polyfill: { installAll(): void };
  Player: {
    new (video: HTMLVideoElement): ShakaPlayerLike;
    isBrowserSupported(): boolean;
  };
}

/**
 * Mount a Shaka Player on `videoEl` for the given `mediaId`.
 * Handles: polling while processing, cookie refresh at 80% lifetime,
 * one retry on 403 (re-fetches cookies then calls player.retryStreaming()).
 */
export async function mountPlayer(
  videoEl: HTMLVideoElement,
  mediaId: string,
  opts: MountPlayerOptions,
): Promise<PlayerHandle> {
  const {
    apiBase,
    cdnOrigin,
    pollIntervalMs = DEFAULT_POLL_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    onStatus,
  } = opts;

  let destroyed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let shakaPlayer: ShakaPlayerLike | null = null;

  const emit = (status: PlayerStatus, detail?: string) => onStatus?.(status, detail);

  function clearRefresh() {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  function scheduleRefresh(expiresAt: number) {
    clearRefresh();
    const now = Date.now();
    const remaining = expiresAt - now;
    const delay = Math.max(0, remaining * REFRESH_FRACTION);

    refreshTimer = setTimeout(async () => {
      if (destroyed) return;
      try {
        const data = await fetchPlayback(apiBase, mediaId);
        if (data.status === 'ready' && data.expiresAt != null) {
          scheduleRefresh(data.expiresAt);
        }
      } catch {
        // Refresh failed — canWatch is now denying; playback will fail on next segment
      }
    }, delay);
  }

  // ── Shaka dynamic import (keeps it out of SSR bundles) ───────────────────
  // shaka-player ships its own types but the import path differs between
  // compiled CJS and ESM. We use `as unknown as ShakaModule` to stay safe.
  const shaka = (await import('shaka-player')) as unknown as ShakaModule;
  shaka.polyfill.installAll();

  if (!shaka.Player.isBrowserSupported()) {
    emit('error', 'Browser not supported by Shaka Player');
    return {
      player: null,
      destroy: () => undefined,
    };
  }

  shakaPlayer = new shaka.Player(videoEl);

  // Allow credentials for CDN origin
  shakaPlayer.getNetworkingEngine().registerRequestFilter(
    (_type: unknown, req: Record<string, unknown>) => {
      if (cdnOrigin) {
        req['allowCrossSiteCredentials'] = true;
      }
    },
  );

  // Retry once on 403
  let retried = false;
  shakaPlayer.addEventListener('error', async (event: unknown) => {
    const err = (event as { detail?: { code?: number } }).detail;
    const BAD_HTTP_STATUS = 1001; // shaka.util.Error.Code.BAD_HTTP_STATUS
    if (err?.code === BAD_HTTP_STATUS && !retried) {
      retried = true;
      try {
        const data = await fetchPlayback(apiBase, mediaId);
        if (data.status === 'ready' && data.expiresAt != null) {
          scheduleRefresh(data.expiresAt);
        }
        shakaPlayer?.retryStreaming();
      } catch {
        emit('error', 'Playback access revoked');
      }
    } else if (err?.code === BAD_HTTP_STATUS) {
      emit('error', 'Playback access denied');
    }
  });

  // ── Poll until ready ──────────────────────────────────────────────────────
  emit('loading');
  const deadline = Date.now() + maxWaitMs;

  while (!destroyed) {
    const data = await fetchPlayback(apiBase, mediaId);

    if (data.status === 'processing') {
      emit('processing');
      if (Date.now() > deadline) {
        emit('error', 'Timed out waiting for video to process');
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
      continue;
    }

    // ready
    if (data.manifestUrl == null || data.expiresAt == null) {
      emit('error', 'Invalid playback response');
      break;
    }

    await shakaPlayer.load(data.manifestUrl);
    scheduleRefresh(data.expiresAt);
    emit('ready');
    break;
  }

  const player = shakaPlayer;

  return {
    player,
    destroy() {
      destroyed = true;
      clearRefresh();
      void player?.destroy();
    },
  };
}
