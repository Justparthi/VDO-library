/**
 * dev/fake-cdn/server.mjs
 *
 * Local stand-in for CloudFront with signed-cookie verification.
 *
 * For each incoming request:
 *  1. Read CloudFront-Policy, CloudFront-Signature, CloudFront-Key-Pair-Id cookies.
 *  2. Decode the policy (CloudFront base64 variant: '-' -> '+', '_' -> '=', '~' -> '/').
 *  3. Verify the RSA-SHA1 signature with the local PUBLIC key.
 *  4. Check DateLessThan (expiry) and that the request URL matches the Resource wildcard.
 *  5. Stream the file from the output bucket (SeaweedFS).
 *  6. Reject with 403 if any check fails.
 *
 * NOTE: We intentionally read the @aws-sdk/cloudfront-signer source to confirm
 * it uses RSA-SHA1 (SHA1withRSA) for signature verification — that is the algorithm
 * CloudFront uses, and the signer signs with RSA-SHA1 accordingly.
 *
 * CORS: exact app origin, credentials:true.
 */

import express from 'express';
import { createServer as createHttpsServer } from 'node:https';
import { createVerify } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config from env ───────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.FAKE_CDN_PORT ?? '3002', 10);
const APP_ORIGIN   = `https://${process.env.APP_DOMAIN ?? 'local.myapp.test'}`;
const DEST_BUCKET  = process.env.DEST_BUCKET ?? 'output';
const S3_ENDPOINT  = process.env.S3_ENDPOINT ?? 'http://localhost:8333';
const PUBLIC_KEY_FILE = process.env.CF_PUBLIC_KEY_FILE ??
  join(__dirname, '..', 'keys', 'public.pem');

const PUBLIC_KEY = readFileSync(PUBLIC_KEY_FILE, 'utf8');

const s3 = new S3Client({
  region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     ?? 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
  },
});

const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', APP_ORIGIN);
  res.set('Access-Control-Allow-Credentials', 'true');
  res.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Range');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ── CloudFront base64 decode (CF uses a non-standard variant) ─────────────────
// @aws-sdk/cloudfront-signer encodes with: '-' for '+', '~' for '/', '_' for '='
// So to decode: '-' -> '+', '~' -> '/', '_' -> '='
function cfBase64Decode(input) {
  const standard = input.replace(/-/g, '+').replace(/~/g, '/').replace(/_/g, '=');
  return Buffer.from(standard, 'base64');
}

// ── Wildcard resource matching (same as CloudFront) ───────────────────────────
// The resource ends with /* — we check the path starts with the prefix.
function matchesResource(resource, requestUrl) {
  if (resource.endsWith('/*')) {
    const prefix = resource.slice(0, -1); // remove '*', keep the '/'
    return requestUrl.startsWith(prefix);
  }
  return requestUrl === resource;
}

// ── Cookie verification ───────────────────────────────────────────────────────
function verifyCookies(req) {
  const rawPolicy    = req.cookies?.['CloudFront-Policy'];
  const rawSig       = req.cookies?.['CloudFront-Signature'];
  const rawKeyPairId = req.cookies?.['CloudFront-Key-Pair-Id'];

  if (!rawPolicy || !rawSig || !rawKeyPairId) {
    return { ok: false, reason: 'Missing CloudFront cookies' };
  }

  // Decode policy
  let policy;
  try {
    const policyJson = cfBase64Decode(rawPolicy).toString('utf8');
    policy = JSON.parse(policyJson);
  } catch {
    return { ok: false, reason: 'Invalid policy encoding' };
  }

  const statement = policy?.Statement?.[0];
  if (!statement) {
    return { ok: false, reason: 'Missing policy Statement' };
  }

  // Check expiry
  const epochTime = statement?.Condition?.DateLessThan?.['AWS:EpochTime'];
  if (!epochTime || Date.now() / 1000 > epochTime) {
    return { ok: false, reason: 'Cookies expired' };
  }

  // Check resource wildcard
  const resource = statement?.Resource;
  const proto = req.protocol;
  const host  = req.hostname;
  const hostWithPort = req.headers.host || host;
  const url   = `${proto}://${host}${req.path}`;
  const urlWithPort = `${proto}://${hostWithPort}${req.path}`;
  if (!resource || (!matchesResource(resource, url) && !matchesResource(resource, urlWithPort))) {
    return { ok: false, reason: `Resource mismatch: ${resource} vs ${url}` };
  }

  // Verify RSA-SHA1 signature over the raw (encoded) policy
  // CloudFront signs the raw policy bytes with RSA-SHA1
  const sigBuf = cfBase64Decode(rawSig);
  const policyBuf = cfBase64Decode(rawPolicy);
  const verify = createVerify('RSA-SHA1');
  verify.update(policyBuf);
  const valid = verify.verify(PUBLIC_KEY, sigBuf);

  if (!valid) {
    return { ok: false, reason: 'Invalid signature' };
  }

  return { ok: true };
}

// ── Cookie parser (minimal, no dep needed) ────────────────────────────────────
app.use((req, _res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) req.cookies[k.trim()] = rest.join('=').trim();
  }
  next();
});

// ── Main handler ──────────────────────────────────────────────────────────────
app.get('*', async (req, res) => {
  const check = verifyCookies(req);
  if (!check.ok) {
    console.warn(`[fake-cdn] 403 ${req.path} — ${check.reason}`);
    res.status(403).json({ error: check.reason });
    return;
  }

  // Strip leading slash for S3 key
  const s3Key = req.path.replace(/^\//, '');

  try {
    const cmd = new GetObjectCommand({ Bucket: DEST_BUCKET, Key: s3Key });
    const obj = await s3.send(cmd);

    if (obj.ContentType) res.set('Content-Type', obj.ContentType);
    if (obj.ContentLength) res.set('Content-Length', String(obj.ContentLength));
    res.set('Cache-Control', 'private, max-age=30');

    // Stream body
    if (obj.Body instanceof Readable) {
      obj.Body.pipe(res);
    } else {
      // SDK v3 returns a ReadableStream in some environments
      const chunks = [];
      for await (const chunk of obj.Body) {
        chunks.push(chunk);
      }
      res.send(Buffer.concat(chunks));
    }
  } catch (err) {
    // If S3 is down or not running, check dev/output-storage/output/<s3Key>
    const localFallbackPath = join(__dirname, '..', 'output-storage', DEST_BUCKET, s3Key);
    if (existsSync(localFallbackPath)) {
      if (s3Key.endsWith('.m3u8')) res.set('Content-Type', 'application/vnd.apple.mpegurl');
      else if (s3Key.endsWith('.ts')) res.set('Content-Type', 'video/mp2t');
      return res.sendFile(localFallbackPath);
    }
    const name = err?.name ?? '';
    if (name === 'NoSuchKey' || name === 'NotFound') {
      res.status(404).json({ error: 'Not found' });
    } else {
      console.error('[fake-cdn] S3 error:', err?.message || err);
      res.status(502).json({ error: 'Storage error' });
    }
  }
});

const certPath = process.env.SSL_CERT_FILE ?? join(__dirname, '..', 'certs', 'local-cert.pem');
const keyPath  = process.env.SSL_KEY_FILE  ?? join(__dirname, '..', 'certs', 'local-key.pem');

if (existsSync(certPath) && existsSync(keyPath)) {
  const httpsOptions = {
    cert: readFileSync(certPath),
    key:  readFileSync(keyPath),
  };
  createHttpsServer(httpsOptions, app).listen(PORT, () => {
    console.log(`🎬  Fake CDN listening on HTTPS port ${PORT} (https://cdn.myapp.test:${PORT})`);
    console.log(`    App origin:  ${APP_ORIGIN}`);
    console.log(`    Dest bucket: ${DEST_BUCKET}  @ ${S3_ENDPOINT}`);
    console.log(`    Public key:  ${PUBLIC_KEY_FILE}`);
  });
} else {
  app.listen(PORT, () => {
    console.log(`🎬  Fake CDN listening on HTTP port ${PORT}`);
    console.log(`    App origin:  ${APP_ORIGIN}`);
    console.log(`    Dest bucket: ${DEST_BUCKET}  @ ${S3_ENDPOINT}`);
    console.log(`    Public key:  ${PUBLIC_KEY_FILE}`);
  });
}
