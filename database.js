const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

let pool;
let initPromise;

// PostgreSQL connection pool
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5, // Neon free tier 限制連線數
      ssl: process.env.DATABASE_URL?.includes('localhost')
        ? false
        : {
            rejectUnauthorized: false,
            // Use libpq compat mode for sslmode=require to work reliably
            ...(process.env.DATABASE_URL?.includes('neon.tech')
              ? { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }
              : {})
          },
    });
  }
  return pool;
}

async function initDatabase() {
  if (initPromise) return initPromise;
  initPromise = _initDatabase();
  return initPromise;
}

async function _initDatabase() {
  const p = getPool();
  const client = await p.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT,
        email TEXT,
        role TEXT DEFAULT 'member' CHECK(role IN ('admin', 'member')),
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        sort_order INTEGER DEFAULT 0,
        is_admin_only INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: add is_admin_only if missing
    try {
      await client.query(`ALTER TABLE categories ADD COLUMN is_admin_only INTEGER DEFAULT 0`);
    } catch (e) { /* ignore */ }

    await client.query(`
      CREATE TABLE IF NOT EXISTS albums (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        category_id INTEGER,
        cover_photo_id INTEGER,
        is_public INTEGER DEFAULT 1,
        user_id INTEGER,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES categories(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS photos (
        id SERIAL PRIMARY KEY,
        album_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT,
        imgbb_url TEXT,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
      )
    `);

    // Migration: add imgbb_url if missing
    try {
      await client.query(`ALTER TABLE photos ADD COLUMN imgbb_url TEXT`);
    } catch (e) { /* ignore */ }

    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    await client.query(`
      INSERT INTO settings (key, value) VALUES ('banner_url', '')
      ON CONFLICT (key) DO NOTHING
    `);
    await client.query(`
      INSERT INTO settings (key, value) VALUES ('banner_text', '電子相簿')
      ON CONFLICT (key) DO NOTHING
    `);

    const catCheck = await client.query(`SELECT COUNT(*)::int as c FROM categories`);
    if (catCheck.rows[0].c === 0) {
      const cats = [
        ['活動花絮', 1], ['捐血活動', 2], ['社會服務', 3],
        ['授證典禮', 4], ['旅遊聯誼', 5], ['其他', 6]
      ];
      for (const [name, order] of cats) {
        await client.query(
          `INSERT INTO categories (name, sort_order) VALUES ($1, $2)`,
          [name, order]
        );
      }
    }

    const userCheck = await client.query(
      `SELECT COUNT(*)::int as c FROM users WHERE role = 'admin'`
    );
    if (userCheck.rows[0].c === 0) {
      const hashed = bcrypt.hashSync('admin123', 10);
      await client.query(
        `INSERT INTO users (username, password, display_name, role) VALUES ($1, $2, $3, $4)`,
        ['admin', hashed, '系統管理員', 'admin']
      );
    }

    console.log('✅ PostgreSQL 資料庫初始化完成');
  } finally {
    client.release();
  }

  return p;
}

// No-op: PostgreSQL persists automatically
function saveDatabase() {}

// Synchronous-looking prepare() interface matching original SQLite API.
// All three methods (run/get/all) are async and MUST be awaited.
function prepare(sql) {
  const isMutate = /^(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql.trim());

  return {
    run: async (...params) => {
      const p = getPool();
      const client = await p.connect();
      try {
        await client.query(sql, params);
        let lastInsertRowid = null;
        if (isMutate) {
          const lv = await client.query('SELECT lastval()::int');
          lastInsertRowid = lv.rows[0]?.lastval ?? null;
        }
        return { lastInsertRowid };
      } finally {
        client.release();
      }
    },
    get: async (...params) => {
      const p = getPool();
      const r = await p.query(sql, params);
      return r.rows[0] || null;
    },
    all: async (...params) => {
      const p = getPool();
      const r = await p.query(sql, params);
      return r.rows;
    }
  };
}

module.exports = { initDatabase, getDb: getPool, prepare, saveDatabase };
