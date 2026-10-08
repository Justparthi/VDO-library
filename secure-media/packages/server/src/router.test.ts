import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { createMediaRouter } from '../src/router.js';
import type { MediaStore, MediaRecord } from '../src/store.js';
import type { MediaConfig, MediaRouterOptions } from '../src/config.js';

// ─── Minimal in-memory store ────────────────────────────────────────────────
function makeStore(initial?: MediaRecord): MediaStore {
  const db = new Map<string, MediaRecord>(initial ? [[initial.id, initial]] : []);
  return {
    insert: vi.fn(async (r) => { db.set(r.id, { ...r }); }),
    find:   vi.fn(async (id) => db.get(id)),
    update: vi.fn(async (id, fields) => {
      const rec = db.get(id);
      if (rec) db.set(id, { ...rec, ...fields });
    }),
  };
}

// ─── AWS SDK mocks ───────────────────────────────────────────────────────────
vi.mock('@aws-sdk/client-s3', () => {
  const send = vi.fn();
  const S3Client = vi.fn(() => ({ send }));
  const PutObjectCommand = vi.fn((input: unknown) => ({ input }));
  const HeadObjectCommand = vi.fn((input: unknown) => ({ input }));
  return { S3Client, PutObjectCommand, HeadObjectCommand, __send: send };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://s3.example.com/presigned-put-url'),
}));

vi.mock('@aws-sdk/cloudfront-signer', () => ({
  getSignedCookies: vi.fn(() => ({
    'CloudFront-Policy': 'policy-value',
    'CloudFront-Signature': 'sig-value',
    'CloudFront-Key-Pair-Id': 'kp-value',
  })),
}));

// ─── Test helpers ────────────────────────────────────────────────────────────
const baseConfig: MediaConfig = {
  region: 'us-east-1',
  sourceBucket: 'src-bucket',
  destBucket: 'dest-bucket',
  cdnDomain: 'cdn.myapp.test',
  cookieDomain: '.myapp.test',
  cfKeyPairId: 'K123',
  cfPrivateKey: '-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----',
  cookieTtlSeconds: 600,
  prefix: (id) => `videos/${id}`,
  manifest: (id) => `videos/${id}/master.m3u8`,
};

function makeApp(overrides: Partial<MediaRouterOptions> = {}, store?: MediaStore): Express {
  const app = express();
  app.use(express.json());
  const opts: MediaRouterOptions = {
    config: baseConfig,
    store: store ?? makeStore(),
    getUserId: () => 'user-1',
    canUpload: () => true,
    canWatch: () => true,
    ...overrides,
  };
  app.use('/api/media', createMediaRouter(opts));
  return app;
}

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('POST /api/media', () => {
  it('returns 201 with id and uploadUrl', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/media').send({ protected: false });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      uploadUrl: 'https://s3.example.com/presigned-put-url',
    });
  });

  it('defaults protected to TRUE when not provided', async () => {
    const store = makeStore();
    const app = makeApp({}, store);
    const res = await request(app).post('/api/media').send({});
    expect(res.status).toBe(201);
    // find the inserted record
    const id: string = res.body.id as string;
    const rec = await store.find(id);
    expect(rec?.protected).toBe(true);
  });

  it('returns 403 when canUpload denies', async () => {
    const app = makeApp({ canUpload: () => false });
    const res = await request(app).post('/api/media').send({});
    expect(res.status).toBe(403);
  });
});

describe('GET /api/media/:id/playback', () => {
  it('returns 404 for unknown id', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/media/unknown-id/playback');
    expect(res.status).toBe(404);
  });

  it('returns 403 when canWatch denies', async () => {
    const record: MediaRecord = {
      id: 'vid-1',
      protected: true,
      status: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const app = makeApp({ canWatch: () => false }, makeStore(record));
    const res = await request(app).get('/api/media/vid-1/playback');
    expect(res.status).toBe(403);
  });

  it('returns 202 when manifest not yet in S3', async () => {
    const { __send } = await import('@aws-sdk/client-s3') as unknown as { __send: ReturnType<typeof vi.fn> };
    __send.mockRejectedValueOnce(Object.assign(new Error('not found'), { name: 'NotFound' }));

    const record: MediaRecord = {
      id: 'vid-2',
      protected: false,
      status: 'processing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const app = makeApp({}, makeStore(record));
    const res = await request(app).get('/api/media/vid-2/playback');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'processing' });
  });

  it('returns 200 with manifestUrl + 3 cookies when ready', async () => {
    const { __send } = await import('@aws-sdk/client-s3') as unknown as { __send: ReturnType<typeof vi.fn> };
    __send.mockResolvedValueOnce({}); // HEAD succeeds

    const record: MediaRecord = {
      id: 'vid-3',
      protected: false,
      status: 'processing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const app = makeApp({}, makeStore(record));
    const res = await request(app).get('/api/media/vid-3/playback');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.manifestUrl).toBe('https://cdn.myapp.test/videos/vid-3/master.m3u8');
    expect(typeof res.body.expiresAt).toBe('number');

    const setCookies: string[] = res.headers['set-cookie'] as string[];
    expect(setCookies).toHaveLength(3);
    const joined = setCookies.join('\n');
    // All three CF cookies must be present
    expect(joined).toContain('CloudFront-Policy');
    expect(joined).toContain('CloudFront-Signature');
    expect(joined).toContain('CloudFront-Key-Pair-Id');
    // Security flags
    expect(joined).toContain('Secure');
    expect(joined).toContain('HttpOnly');
    expect(joined).toContain('SameSite=None');
    // Domain and path scoping
    expect(joined).toContain('Domain=.myapp.test');
    expect(joined).toContain('Path=/videos/vid-3');
  });

  it('propagates unexpected S3 errors (does not swallow)', async () => {
    const { __send } = await import('@aws-sdk/client-s3') as unknown as { __send: ReturnType<typeof vi.fn> };
    __send.mockRejectedValueOnce(Object.assign(new Error('access denied'), { name: 'AccessDenied' }));

    const record: MediaRecord = {
      id: 'vid-4',
      protected: false,
      status: 'processing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    // Add an error handler so express doesn't crash the test process
    const store = makeStore(record);
    const app = makeApp({}, store);
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'internal' });
    });
    const res = await request(app).get('/api/media/vid-4/playback');
    expect(res.status).toBe(500);
  });

  it('returns Cache-Control: no-store on ready response', async () => {
    const { __send } = await import('@aws-sdk/client-s3') as unknown as { __send: ReturnType<typeof vi.fn> };
    __send.mockResolvedValueOnce({});

    const record: MediaRecord = {
      id: 'vid-5',
      protected: false,
      status: 'processing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const app = makeApp({}, makeStore(record));
    const res = await request(app).get('/api/media/vid-5/playback');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
