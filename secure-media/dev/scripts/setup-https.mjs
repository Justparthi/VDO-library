#!/usr/bin/env node
/**
 * dev/scripts/setup-https.mjs
 *
 * Sets up local HTTPS for myapp.test subdomains:
 *  1. Runs `mkcert -install` to install the local CA.
 *  2. Issues a cert covering local.myapp.test and cdn.myapp.test.
 *  3. Writes the cert files to dev/certs/.
 *  4. Prints the hosts file entries you need to add manually (requires admin).
 *
 * Usage:  node dev/scripts/setup-https.mjs
 *         (Run as Administrator on Windows for automatic hosts file update)
 */
import { execSync } from 'node:child_process';
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const certsDir = join(__dirname, '..', 'certs');
mkdirSync(certsDir, { recursive: true });

const APP_DOMAIN = process.env.APP_DOMAIN ?? 'local.myapp.test';
const CDN_DOMAIN = process.env.CDN_DOMAIN ?? 'cdn.myapp.test';

console.log('🔐  Installing mkcert local CA...');
try {
  execSync('mkcert -install', { stdio: 'inherit' });
} catch {
  console.warn('⚠️  mkcert -install failed. You may need to run as Administrator.');
}

const certFile = join(certsDir, 'local-cert.pem');
const keyFile  = join(certsDir, 'local-key.pem');

console.log(`\n🔑  Generating cert for ${APP_DOMAIN} and ${CDN_DOMAIN}...`);
execSync(
  `mkcert -cert-file "${certFile}" -key-file "${keyFile}" "${APP_DOMAIN}" "${CDN_DOMAIN}"`,
  { stdio: 'inherit', cwd: certsDir },
);

console.log('\n✅  Certs written to dev/certs/');
console.log('    Cert: ', certFile);
console.log('    Key:  ', keyFile);

// ── Hosts file ────────────────────────────────────────────────────────────────
const HOSTS_ENTRY = `\n# secure-media local dev\n127.0.0.1  ${APP_DOMAIN}\n127.0.0.1  ${CDN_DOMAIN}\n`;
const hostsPath =
  platform() === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';

const hostsContent = existsSync(hostsPath) ? readFileSync(hostsPath, 'utf8') : '';

if (hostsContent.includes(APP_DOMAIN)) {
  console.log(`\n✅  Hosts file already contains entries for ${APP_DOMAIN}.`);
} else {
  try {
    appendFileSync(hostsPath, HOSTS_ENTRY);
    console.log(`\n✅  Hosts entries added to ${hostsPath}.`);
  } catch {
    console.log('\n⚠️  Could not write to hosts file (need Administrator privileges).');
    console.log('    Add these lines to your hosts file manually:');
    console.log(HOSTS_ENTRY);
  }
}

console.log('\nNext: set these in your .env:');
console.log(`  SSL_CERT_FILE=dev/certs/local-cert.pem`);
console.log(`  SSL_KEY_FILE=dev/certs/local-key.pem`);
