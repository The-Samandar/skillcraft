// db/init.js — инициализация SQLite через sql.js (работает на Node 24)
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || './db/skillcraft.sqlite';
const resolvedPath = path.resolve(dbPath);
const dbDir = path.dirname(resolvedPath);

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let _db = null;
let dbProxy = null;

function save() {
  if (!_db) return;
  fs.writeFileSync(resolvedPath, Buffer.from(_db.export()));
}

function named(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return p;
  const out = {};
  for (const [k, v] of Object.entries(p)) out[`@${k}`] = v;
  return out;
}

function makeProxy() {
  return {
    exec(sql) { _db.run(sql); save(); },
    prepare(sql) {
      return {
        run(p, ...rest) {
          try {
            if (p && typeof p === 'object' && !Array.isArray(p)) _db.run(sql, named(p));
            else { const a = p !== undefined ? [p, ...rest] : []; _db.run(sql, a.length ? a : undefined); }
            save();
          } catch(e) { console.error('DB.run:', e.message, '\n', sql); throw e; }
          return {};
        },
        get(p, ...rest) {
          try {
            let r;
            if (p && typeof p === 'object' && !Array.isArray(p)) r = _db.exec(sql, named(p));
            else { const a = p !== undefined ? [p, ...rest] : []; r = _db.exec(sql, a.length ? a : undefined); }
            if (!r?.[0]) return undefined;
            const obj = {}; r[0].columns.forEach((c,i) => obj[c] = r[0].values[0]?.[i]); return r[0].values[0] ? obj : undefined;
          } catch(e) { console.error('DB.get:', e.message, '\n', sql); throw e; }
        },
        all(p, ...rest) {
          try {
            let r;
            if (p && typeof p === 'object' && !Array.isArray(p)) r = _db.exec(sql, named(p));
            else { const a = p !== undefined ? [p, ...rest] : []; r = _db.exec(sql, a.length ? a : undefined); }
            if (!r?.[0]) return [];
            return r[0].values.map(row => { const obj = {}; r[0].columns.forEach((c,i) => obj[c] = row[i]); return obj; });
          } catch(e) { console.error('DB.all:', e.message, '\n', sql); throw e; }
        },
      };
    },
    pragma() {},
    transaction(fn) {
      return (...args) => {
        _db.run('BEGIN');
        try { fn(...args); _db.run('COMMIT'); save(); }
        catch(e) { try { _db.run('ROLLBACK'); } catch(_) {} throw e; }
      };
    },
  };
}

async function initDatabase() {
  const SQL = await initSqlJs();
  _db = fs.existsSync(resolvedPath)
    ? new SQL.Database(fs.readFileSync(resolvedPath))
    : new SQL.Database();

  dbProxy = makeProxy();

  _db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      device_token TEXT,
      created_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_code TEXT UNIQUE NOT NULL,
      user_id TEXT,
      amount INTEGER NOT NULL,
      provider TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_transaction_id TEXT,
      amount INTEGER NOT NULL,
      raw_payload TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      file_name TEXT,
      file_path TEXT,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS access_grants (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      user_id TEXT,
      access_type TEXT DEFAULT 'full_course',
      is_active INTEGER DEFAULT 1,
      granted_at DATETIME DEFAULT (datetime('now'))
    );
  `);

  save();
  console.log('✅ Database initialized');
  return dbProxy;
}

const db = new Proxy({}, {
  get(_, prop) {
    if (!dbProxy) throw new Error('DB not ready. Call initDatabase() first.');
    return dbProxy[prop];
  }
});

module.exports = { db, initDatabase };