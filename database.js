const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, 'photo_album.db'));

// 啟用 foreign key
db.pragma('foreign_keys = ON');

// 初始化資料庫
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT,
      email TEXT,
      role TEXT DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      album_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT,
      description TEXT,
      sort_order INTEGER DEFAULT 0,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_albums_category ON albums(category_id);
    CREATE INDEX IF NOT EXISTS idx_albums_public ON albums(is_public);
    CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album_id);
    CREATE INDEX IF NOT EXISTS idx_photos_sort ON photos(album_id, sort_order);
  `);

  // 預設分類（如果還沒有）
  const categoryCount = db.prepare('SELECT COUNT(*) as count FROM categories').get();
  if (categoryCount.count === 0) {
    const insertCategory = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
    const defaultCategories = [
      ['活動花絮', 1],
      ['捐血活動', 2],
      ['社會服務', 3],
      ['授證典禮', 4],
      ['旅遊聯誼', 5],
      ['其他', 6]
    ];
    defaultCategories.forEach(([name, order]) => insertCategory.run(name, order));
  }

  // 預設管理員帳號（如果還沒有）
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin');
  if (userCount.count === 0) {
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT INTO users (username, password, display_name, role)
      VALUES (?, ?, ?, ?)
    `).run('admin', hashedPassword, '系統管理員', 'admin');
  }

  console.log('✅ 資料庫初始化完成');
}

module.exports = { db, initDatabase };
