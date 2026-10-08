/**
 * dev/example-app/store.mjs
 *
 * sql.js-backed MediaStore implementation.
 * sql.js is pure WebAssembly — no C++ build tools needed.
 * Satisfies the MediaStore interface from @secure-media/server.
 *
 * NOTE: sql.js keeps the DB in memory; we flush to disk on every write
 * using Node's fs.writeFileSync so data survives restarts.
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// sql.js ships a WASM binary alongside the JS; point it at the right path.
const initSqlJs = require('sql.js');

const DB_PATH = join(__dirname, 'media.db');

// ── Init ──────────────────────────────────────────────────────────────────────
const SQL = await initSqlJs();

let db;
if (existsSync(DB_PATH)) {
  const fileBuffer = readFileSync(DB_PATH);
  db = new SQL.Database(fileBuffer);
} else {
  db = new SQL.Database();
}

function persist() {
  const data = db.export();
  writeFileSync(DB_PATH, Buffer.from(data));
}

db.run(`
  CREATE TABLE IF NOT EXISTS media (
    id         TEXT PRIMARY KEY,
    protected  INTEGER NOT NULL DEFAULT 1,
    status     TEXT    NOT NULL DEFAULT 'uploading',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
persist();

// ── Prepared-statement helpers ────────────────────────────────────────────────
function rowToRecord(row) {
  if (!row) return undefined;
  return {
    id:        row.id,
    protected: row.protected === 1,
    status:    row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** @type {import('@secure-media/server').MediaStore} */
export const sqliteStore = {
  async insert(record) {
    db.run(
      `INSERT INTO media (id, protected, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [record.id, record.protected ? 1 : 0, record.status, record.createdAt, record.updatedAt],
    );
    persist();
  },

  async find(id) {
    const stmt = db.prepare(`SELECT * FROM media WHERE id = ?`);
    stmt.bind([id]);
    const row = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return rowToRecord(row);
  },

  async update(id, fields) {
    const now = fields.updatedAt ?? Date.now();
    if (fields.status !== undefined) {
      db.run(`UPDATE media SET status = ?, updated_at = ? WHERE id = ?`, [fields.status, now, id]);
    }
    if (fields.protected !== undefined) {
      db.run(`UPDATE media SET protected = ?, updated_at = ? WHERE id = ?`, [fields.protected ? 1 : 0, now, id]);
    }
    if (fields.status === undefined && fields.protected === undefined) {
      db.run(`UPDATE media SET updated_at = ? WHERE id = ?`, [now, id]);
    }
    persist();
  },
};
