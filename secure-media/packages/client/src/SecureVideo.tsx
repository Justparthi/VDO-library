import React, { useEffect, useRef, useState } from 'react';
import { mountPlayer } from './mount-player.js';
import type { MountPlayerOptions, PlayerStatus } from './types.js';

export interface SecureVideoProps extends Omit<MountPlayerOptions, 'onStatus'> {
  mediaId: string;
  /** Additional CSS class for the wrapper div. */
  className?: string;
  /** Inline styles for the wrapper div. */
  style?: React.CSSProperties;
}

/**
 * Drop-in React component. Usage:
 *
 *   <SecureVideo
 *     mediaId={id}
 *     apiBase="https://local.myapp.test/api/media"
 *     cdnOrigin="https://cdn.myapp.test"
 *   />
 */
export function SecureVideo({
  mediaId,
  apiBase,
  cdnOrigin,
  pollIntervalMs,
  maxWaitMs,
  className,
  style,
}: SecureVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<PlayerStatus>('loading');
  const [errorDetail, setErrorDetail] = useState<string | undefined>();

  useEffect(() => {
    if (!videoRef.current) return;

    const videoEl = videoRef.current;
    let destroyed = false;
    let handle: Awaited<ReturnType<typeof mountPlayer>> | null = null;

    void mountPlayer(videoEl, mediaId, {
      apiBase,
      cdnOrigin,
      ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      ...(maxWaitMs !== undefined ? { maxWaitMs } : {}),
      onStatus(s, detail) {
        if (!destroyed) {
          setStatus(s);
          if (s === 'error') setErrorDetail(detail);
        }
      },
    }).then((h) => {
      if (destroyed) {
        h.destroy();
      } else {
        handle = h;
      }
    });

    return () => {
      destroyed = true;
      handle?.destroy();
    };
  }, [mediaId, apiBase, cdnOrigin, pollIntervalMs, maxWaitMs]);

  return (
    <div className={className} style={{ position: 'relative', ...style }}>
      <video
        ref={videoRef}
        controls
        style={{ width: '100%', display: status === 'ready' ? 'block' : 'none' }}
      />
      {status === 'processing' && (
        <div role="status" aria-label="Processing video">
          <p>⏳ Processing… this may take a moment.</p>
        </div>
      )}
      {status === 'loading' && (
        <div role="status" aria-label="Loading player">
          <p>Loading…</p>
        </div>
      )}
      {status === 'error' && (
        <div role="alert">
          <p>❌ {errorDetail ?? 'Playback error'}</p>
        </div>
      )}
    </div>
  );
}
