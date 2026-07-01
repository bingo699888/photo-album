const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

let db;

async function initDatabase() {
  const SQL = await initSqlJs();
  
  const dbPath = path.join(__dirname, 'photo_album.db');
  
  // 讀取現有資料庫或建立新的
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 建立表格
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT,
      email TEXT,
      role TEXT DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      category_id INTEGER,
      cover_photo_id INTEGER,
      is_public INTEGER DEFAULT 1,
      user_id INTEGER,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
    )
  `);

  // 預設分類
  const catCount = db.exec("SELECT COUNT(*) as count FROM categories")[0];
  if (!catCount || catCount.values[0][0] === 0) {
    const defaultCategories = [
      ['活動花絮', 1],
      ['捐血活動', 2],
      ['社會服務', 3],
      ['授證典禮', 4],
      ['旅遊聯誼', 5],
      ['其他', 6]
    ];
    defaultCategories.forEach(([name, order]) => {
      db.run('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [name, order]);
    });
  }

  // 預設管理員
  const userCount = db.exec("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")[0];
  if (!userCount || userCount.values[0][0] === 0) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.run(
      'INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)',
      ['admin', hashedPassword, '系統管理員', 'admin']
    );
  }

  saveDatabase();
  console.log('✅ 資料庫初始化完成');
  return db;
}

function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(path.join(__dirname, 'photo_album.db'), buffer);
}

// 簡化查詢介面
function prepare(sql) {
  return {
    run: (...params) => {
      db.run(sql, params);
      saveDatabase();
      return { lastInsertRowid: db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] };
    },
    get: (...params) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      }
      stmt.free();
      return null;
    },
    all: (...params) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const results = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return results;
    }
  };
}

module.exports = { initDatabase, getDb: () => db, prepare, saveDatabase };
