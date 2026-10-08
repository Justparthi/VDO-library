#!/usr/bin/env node
/**
 * dev/scripts/gen-keys.mjs
 *
 * Generates a 2048-bit RSA key pair for local CloudFront cookie signing.
 * Writes:
 *   dev/keys/private.pem   — private key (GITIGNORED)
 *   dev/keys/public.pem    — public key  (safe to commit, optional)
 *
 * Usage:  node dev/scripts/gen-keys.mjs
 *         npm run dev:keys
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const keysDir = join(__dirname, '..', 'keys');

mkdirSync(keysDir, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const privatePath = join(keysDir, 'private.pem');
const publicPath  = join(keysDir, 'public.pem');

writeFileSync(privatePath, privateKey,  { mode: 0o600 });
writeFileSync(publicPath,  publicKey);

console.log('✅  RSA key pair generated:');
console.log('   private:', privatePath);
console.log('   public: ', publicPath);
console.log('');
console.log('Add to your .env (or .env.local):');
// Output single-line for easy copy-paste into .env
console.log(`CF_PRIVATE_KEY_FILE=dev/keys/private.pem`);
console.log(`CF_KEY_PAIR_ID=local-dev-key`);
console.log('');
console.log('⚠️  dev/keys/ is gitignored. Never commit the private key.');
