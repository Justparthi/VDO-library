import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSignedCookies } from '@aws-sdk/cloudfront-signer';
import request from 'supertest';
import express from 'express';
import { createVerify } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../..');
const privateKey = readFileSync(join(ROOT, 'dev/keys/private.pem'), 'utf8');
const publicKey = readFileSync(join(ROOT, 'dev/keys/public.pem'), 'utf8');

function cfBase64Decode(input) {
  const standard = input.replace(/-/g, '+').replace(/~/g, '/').replace(/_/g, '=');
  return Buffer.from(standard, 'base64');
}

function matchesResource(resource, requestUrl) {
  if (resource.endsWith('/*')) {
    const prefix = resource.slice(0, -1);
    return requestUrl.startsWith(prefix);
  }
  return requestUrl === resource;
}

function verifyCookies(req, pubKey) {
  const rawPolicy = req.cookies?.['CloudFront-Policy'];
  const rawSig = req.cookies?.['CloudFront-Signature'];
  const rawKeyPairId = req.cookies?.['CloudFront-Key-Pair-Id'];

  if (!rawPolicy || !rawSig || !rawKeyPairId) {
    return { ok: false, reason: 'Missing CloudFront cookies' };
  }

  let policy;
  try {
    const policyJson = cfBase64Decode(rawPolicy).toString('utf8');
    policy = JSON.parse(policyJson);
  } catch {
    return { ok: false, reason: 'Invalid policy encoding' };
  }

  const statement = policy?.Statement?.[0];
  if (!statement) return { ok: false, reason: 'Missing policy Statement' };

  const epochTime = statement?.Condition?.DateLessThan?.['AWS:EpochTime'];
  if (!epochTime || Date.now() / 1000 > epochTime) {
    return { ok: false, reason: 'Cookies expired' };
  }

  const resource = statement?.Resource;
  const proto = req.protocol;
  const host = req.hostname;
  const hostWithPort = req.headers.host || host;
  const url = `${proto}://${host}${req.path}`;
  const urlWithPort = `${proto}://${hostWithPort}${req.path}`;

  if (!resource || (!matchesResource(resource, url) && !matchesResource(resource, urlWithPort))) {
    return { ok: false, reason: `Resource mismatch: ${resource} vs ${url}` };
  }

  const sigBuf = cfBase64Decode(rawSig);
  const policyBuf = cfBase64Decode(rawPolicy);
  const verify = createVerify('RSA-SHA1');
  verify.update(policyBuf);
  const valid = verify.verify(pubKey, sigBuf);

  if (!valid) return { ok: false, reason: 'Invalid signature' };

  return { ok: true };
}

describe('Fake CDN verification acceptance test', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use((req, _res, next) => {
      req.cookies = {};
      const raw = req.headers.cookie ?? '';
      for (const part of raw.split(';')) {
        const [k, ...rest] = part.trim().split('=');
        if (k) req.cookies[k.trim()] = rest.join('=').trim();
      }
      next();
    });

    app.get('*', (req, res) => {
      const check = verifyCookies(req, publicKey);
      if (!check.ok) {
        return res.status(403).json({ error: check.reason });
      }
      return res.status(200).send('mock-hls-content');
    });
  });

  it('rejects request WITHOUT cookies with 403', async () => {
    const res = await request(app).get('/videos/test-sample-video/master.m3u8');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Missing CloudFront cookies');
  });

  it('accepts request WITH valid signed cookies with 200', async () => {
    const cdnResource = 'http://127.0.0.1/videos/test-sample-video/*';
    const expiresAt = Date.now() + 600 * 1000;

    const cookies = getSignedCookies({
      keyPairId: 'local-dev-key',
      privateKey: privateKey,
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

    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const res = await request(app)
      .get('/videos/test-sample-video/master.m3u8')
      .set('Cookie', cookieHeader)
      .set('Host', '127.0.0.1');

    expect(res.status).toBe(200);
    expect(res.text).toBe('mock-hls-content');
  });

  it('rejects request if path does not match cookie resource', async () => {
    const cdnResource = 'http://127.0.0.1/videos/other-video/*';
    const expiresAt = Date.now() + 600 * 1000;

    const cookies = getSignedCookies({
      keyPairId: 'local-dev-key',
      privateKey: privateKey,
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

    const cookieHeader = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const res = await request(app)
      .get('/videos/test-sample-video/master.m3u8')
      .set('Cookie', cookieHeader)
      .set('Host', '127.0.0.1');

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Resource mismatch');
  });
});
