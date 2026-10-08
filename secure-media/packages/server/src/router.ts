import { Router, type Request, type Response, type NextFunction } from 'express';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import { randomUUID } from 'node:crypto';
import type { MediaRouterOptions } from './config.js';

const UPLOAD_TTL_SECONDS = 15 * 60; // 15 min pre-signed PUT

/**
 * Build and return an Express Router pre-wired to two routes:
 *
 *   POST /            — create media record + return pre-signed upload URL
 *   GET  /:id/playback — access-check, readiness check, issue signed cookies
 *
 * Mount it in the host app:
 *   app.use('/api/media', authMiddleware, createMediaRouter(options));
 */
export function createMediaRouter(options: MediaRouterOptions): Router {
  const { config, store, getUserId, canUpload, canWatch } = options;
  const ttl = config.cookieTtlSeconds ?? 600;

  const s3 = new S3Client({
    region: config.region,
    ...(config.s3Endpoint
      ? {
          endpoint: config.s3Endpoint,
          forcePathStyle: true,
        }
      : {}),
  });

  const router = Router();

  // ─── POST / ───────────────────────────────────────────────────────────────
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const allowed = await canUpload(req);
      if (!allowed) {
        res.status(403).json({ error: 'Upload not permitted' });
        return;
      }

      const isProtected: boolean =
        typeof req.body?.protected === 'boolean' ? req.body.protected : true;

      const id = randomUUID();
      const s3Key = `${id}.mp4`;
      const now = Date.now();

      await store.insert({
        id,
        protected: isProtected,
        status: 'uploading',
        createdAt: now,
        updatedAt: now,
      });

      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: config.sourceBucket,
          Key: s3Key,
          ContentType: 'video/mp4',
        }),
        { expiresIn: UPLOAD_TTL_SECONDS },
      );

      res.status(201).json({ id, uploadUrl });
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /:id/playback ────────────────────────────────────────────────────
  router.get('/:id/playback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as { id: string };

      const media = await store.find(id);
      if (!media) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      const allowed = await canWatch(req, media);
      if (!allowed) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      // ── Readiness check ────────────────────────────────────────────────────
      if (media.status !== 'ready') {
        const manifestKey = config.manifest(id);
        try {
          await s3.send(
            new HeadObjectCommand({ Bucket: config.destBucket, Key: manifestKey }),
          );
          // Found → mark ready
          await store.update(id, { status: 'ready', updatedAt: Date.now() });
        } catch (err: unknown) {
          const name =
            err instanceof Error ? (err as NodeJS.ErrnoException & { name?: string }).name : '';
          if (name === 'NotFound' || name === 'NoSuchKey') {
            res.status(202).json({ status: 'processing' });
            return;
          }
          // Any other S3 error — propagate, do not swallow
          throw err;
        }
      }

      // ── Issue CloudFront signed cookies ────────────────────────────────────
      const prefix = config.prefix(id);
      const cdnResource = `https://${config.cdnDomain}/${prefix}/*`;
      const expiresAt = Date.now() + ttl * 1000;

      const cookies = getSignedCookies({
        keyPairId: config.cfKeyPairId,
        privateKey: config.cfPrivateKey,
        policy: JSON.stringify({
          Statement: [
            {
              Resource: cdnResource,
              Condition: {
                DateLessThan: { 'AWS:EpochTime': Math.floor(expiresAt / 1000) },
              },
            },
          ],
        }),
      });

      const cookieOpts = [
        `Domain=${config.cookieDomain}`,
        `Path=/${prefix}`,
        'Secure',
        'HttpOnly',
        'SameSite=None',
        `Max-Age=${ttl}`,
      ].join('; ');

      for (const [name, value] of Object.entries(cookies)) {
        res.append('Set-Cookie', `${name}=${value}; ${cookieOpts}`);
      }

      const manifestUrl = `https://${config.cdnDomain}/${config.manifest(id)}`;

      res
        .set('Cache-Control', 'no-store')
        .json({ status: 'ready', manifestUrl, expiresAt });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
