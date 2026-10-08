/**
 * dev/example-app/server.mjs
 *
 * Minimal Express server demonstrating the secure-media server package.
 * - Simple session-based auth stub (two hardcoded users: "alice" and "bob")
 * - Alice can watch everything; Bob can only watch unprotected videos
 * - HTTPS via mkcert certs
 */
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { createMediaRouter } from '@secure-media/server';
import { sqliteStore } from './store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

// ── Config from env ─────────────────────────────────────────────────────────
const PORT        = parseInt(process.env.PORT ?? '3001', 10);
const APP_DOMAIN  = process.env.APP_DOMAIN  ?? 'local.myapp.test';
const CDN_DOMAIN  = process.env.CDN_DOMAIN  ?? 'cdn.myapp.test';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN ?? '.myapp.test';
const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret-change-me';

// Private key: prefer env string, fall back to file
let cfPrivateKey = process.env.CF_PRIVATE_KEY ?? '';
if (!cfPrivateKey && process.env.CF_PRIVATE_KEY_FILE) {
  cfPrivateKey = readFileSync(join(ROOT, process.env.CF_PRIVATE_KEY_FILE), 'utf8');
}

const mediaConfig = {
  region:          process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
  sourceBucket:    process.env.SOURCE_BUCKET ?? 'source',
  destBucket:      process.env.DEST_BUCKET   ?? 'output',
  cdnDomain:       CDN_DOMAIN,
  cookieDomain:    COOKIE_DOMAIN,
  cfKeyPairId:     process.env.CF_KEY_PAIR_ID ?? 'local-dev-key',
  cfPrivateKey,
  cookieTtlSeconds: parseInt(process.env.COOKIE_TTL_SECONDS ?? '600', 10),
  s3Endpoint:      process.env.S3_ENDPOINT,
  // Layout functions — update these to match the real AWS MediaConvert output
  prefix:   (id) => `videos/${id}`,
  manifest: (id) => `videos/${id}/master.m3u8`,
};

// ── Stub users ───────────────────────────────────────────────────────────────
// In a real app these come from your DB.
const USERS = {
  alice: { id: 'alice', canWatchAll: true },
  bob:   { id: 'bob',   canWatchAll: false }, // can only watch unprotected
};

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'none', domain: COOKIE_DOMAIN },
}));

// ── Auth stub ────────────────────────────────────────────────────────────────
app.post('/login', (req, res) => {
  const { username } = req.body;
  if (!USERS[username]) {
    res.status(401).json({ error: 'Unknown user. Try "alice" or "bob".' });
    return;
  }
  req.session.userId = username;
  res.json({ ok: true, userId: username });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/me', (req, res) => {
  const userId = req.session?.userId;
  res.json({ userId: userId ?? null });
});

// ── Media router ─────────────────────────────────────────────────────────────
const authRequired = (req, res, next) => {
  if (!req.session?.userId) { res.status(401).json({ error: 'Login required' }); return; }
  next();
};

app.use(
  '/api/media',
  authRequired,
  createMediaRouter({
    config: mediaConfig,
    store:  sqliteStore,

    getUserId: (req) => req.session?.userId ?? null,

    canUpload: (req) => {
      // Any logged-in user can upload
      return Boolean(req.session?.userId);
    },

    canWatch: (req, media) => {
      const userId = req.session?.userId;
      if (!userId) return false;
      const user = USERS[userId];
      if (!user) return false;
      // Alice can watch everything; Bob only unprotected
      if (media.protected) return user.canWatchAll;
      return true;
    },
  }),
);

// ── Static test page ──────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});
app.use('/public', express.static(join(__dirname, 'public')));

// ── HTTPS server ──────────────────────────────────────────────────────────────
const certFile = process.env.SSL_CERT_FILE ?? join(ROOT, 'dev/certs/local-cert.pem');
const keyFile  = process.env.SSL_KEY_FILE  ?? join(ROOT, 'dev/certs/local-key.pem');

let httpsCert, httpsKey;
try {
  httpsCert = readFileSync(certFile);
  httpsKey  = readFileSync(keyFile);
} catch {
  console.error('❌  TLS certs not found. Run:  node dev/scripts/setup-https.mjs');
  process.exit(1);
}

createServer({ cert: httpsCert, key: httpsKey }, app)
  .listen(PORT, () => {
    console.log(`✅  Example app running at https://${APP_DOMAIN}:${PORT}`);
    console.log(`    CDN:  https://${CDN_DOMAIN}`);
    console.log(`    Login: POST /login  body: { "username": "alice" | "bob" }`);
  });
