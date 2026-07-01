const express = require('express');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const { body, validationResult } = require('express-validator');
const { db, initDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化資料庫
initDatabase();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session 設定
const session = require('express-session');
app.use(session({
  secret: process.env.SESSION_SECRET || 'photo-album-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24小時
}));

// 確保上傳目錄存在
const uploadsDir = path.join(__dirname, 'uploads');
const originalsDir = path.join(uploadsDir, 'originals');
const thumbnailsDir = path.join(uploadsDir, 'thumbnails');
[uploadsDir, originalsDir, thumbnailsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer 設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, originalsDir),
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('只允許上傳圖片檔案 (jpg, png, gif, webp)'));
  }
});

// 工具函數：生成縮圖
async function generateThumbnail(filename) {
  const inputPath = path.join(originalsDir, filename);
  const outputPath = path.join(thumbnailsDir, filename);
  try {
    await sharp(inputPath)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(outputPath);
  } catch (err) {
    console.error('生成縮圖失敗:', err);
  }
}

// ===== 中介層 =====

// 登入檢查
function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: '請先登入' });
  }
  next();
}

// 管理員檢查
function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理員權限' });
  }
  next();
}

// ===== 前台 API =====

// 取得分類列表
app.get('/api/categories', (req, res) => {
  try {
    const categories = db.prepare(`
      SELECT c.*, COUNT(a.id) as album_count
      FROM categories c
      LEFT JOIN albums a ON c.id = a.category_id AND a.is_public = 1
      GROUP BY c.id
      ORDER BY c.sort_order
    `).all();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 取得相簿列表（可依分類篩選、可搜尋）
app.get('/api/albums', (req, res) => {
  try {
    const { category_id, search, page = 1, limit = 12 } = req.query;
    const offset = (page - 1) * limit;
    
    let where = 'WHERE a.is_public = 1';
    const params = [];
    
    if (category_id) {
      where += ' AND a.category_id = ?';
      params.push(category_id);
    }
    if (search) {
      where += ' AND (a.title LIKE ? OR a.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    const total = db.prepare(`SELECT COUNT(*) as count FROM albums a ${where}`).get(...params).count;
    const albums = db.prepare(`
      SELECT a.*, c.name as category_name,
             p.filename as cover_filename
      FROM albums a
      LEFT JOIN categories c ON a.category_id = c.id
      LEFT JOIN photos p ON a.cover_photo_id = p.id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset));
    
    res.json({ albums, total, page: Number(page), totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 取得單一相簿（含照片）
app.get('/api/albums/:id', (req, res) => {
  try {
    const album = db.prepare(`
      SELECT a.*, c.name as category_name
      FROM albums a
      LEFT JOIN categories c ON a.category_id = c.id
      WHERE a.id = ? AND a.is_public = 1
    `).get(req.params.id);
    
    if (!album) return res.status(404).json({ error: '相簿不存在' });
    
    const photos = db.prepare(`
      SELECT * FROM photos WHERE album_id = ? ORDER BY sort_order, uploaded_at
    `).all(req.params.id);
    
    res.json({ ...album, photos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 取得單張照片資訊
app.get('/api/photos/:id', (req, res) => {
  try {
    const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
    if (!photo) return res.status(404).json({ error: '照片不存在' });
    res.json(photo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 輸出縮圖
app.get('/thumbnails/:filename', (req, res) => {
  const filePath = path.join(thumbnailsDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('找不到縮圖');
  }
});

// 輸出原圖（需登入）
app.get('/uploads/originals/:filename', requireLogin, (req, res) => {
  const filePath = path.join(originalsDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('找不到檔案');
  }
});

// 下載原始照片（需登入）
app.get('/api/photos/:id/download', requireLogin, (req, res) => {
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: '照片不存在' });
  
  const filePath = path.join(originalsDir, photo.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '檔案不存在' });
  
  res.download(filePath, photo.original_name || photo.filename);
});

// 批次下載相簿照片（需登入）
app.get('/api/albums/:id/download', requireLogin, (req, res) => {
  const photos = db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY sort_order').all(req.params.id);
  if (photos.length === 0) return res.status(404).json({ error: '相簿是空的' });
  
  const archive = archiver('zip', { zlib: { level: 5 } });
  res.attachment('photos.zip');
  archive.pipe(res);
  
  photos.forEach(photo => {
    const filePath = path.join(originalsDir, photo.filename);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: photo.original_name || photo.filename });
    }
  });
  archive.finalize();
});

// ===== 會員 API =====

// 登入
app.post('/api/auth/login', [
  body('username').trim().notEmpty(),
  body('password').notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.displayName = user.display_name;
  
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role
  });
});

// 登出
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// 取得當前使用者資訊
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  res.json({
    id: req.session.userId,
    username: req.session.username,
    displayName: req.session.displayName,
    role: req.session.role
  });
});

// 修改密碼
app.post('/api/auth/change-password', requireLogin, [
  body('oldPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { oldPassword, newPassword } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  
  if (!bcrypt.compareSync(oldPassword, user.password)) {
    return res.status(400).json({ error: '舊密碼錯誤' });
  }
  
  const hashed = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.session.userId);
  
  res.json({ success: true });
});

// 更新個人資料
app.put('/api/auth/profile', requireLogin, [
  body('displayName').optional().trim(),
  body('email').optional().isEmail()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { displayName, email } = req.body;
  db.prepare('UPDATE users SET display_name = ?, email = ? WHERE id = ?')
    .run(displayName || null, email || null, req.session.userId);
  
  req.session.displayName = displayName;
  res.json({ success: true });
});

// ===== 管理後台 API =====

// 會員管理：列表
app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT id, username, display_name, email, role, is_active, created_at
      FROM users ORDER BY created_at DESC
    `).all();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 會員管理：新增
app.post('/api/admin/users', requireAdmin, [
  body('username').trim().notEmpty().isLength({ min: 3 }),
  body('password').isLength({ min: 6 }),
  body('role').isIn(['admin', 'member'])
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { username, password, displayName, email, role } = req.body;
  
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: '帳號已存在' });
  
  const hashed = bcrypt.hashSync(password, 10);
  const result = db.prepare(`
    INSERT INTO users (username, password, display_name, email, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, hashed, displayName || null, email || null, role);
  
  res.json({ id: result.lastInsertRowid, username, displayName, email, role });
});

// 會員管理：更新
app.put('/api/admin/users/:id', requireAdmin, [
  body('role').optional().isIn(['admin', 'member'])
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { id } = req.params;
  const { displayName, email, role, isActive, password } = req.body;
  
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '會員不存在' });
  
  let sql = 'UPDATE users SET display_name = ?, email = ?, role = ?, is_active = ?';
  let params = [displayName || user.display_name, email || user.email, role || user.role, 
                isActive !== undefined ? (isActive ? 1 : 0) : user.is_active];
  
  if (password) {
    sql += ', password = ?';
    params.push(bcrypt.hashSync(password, 10));
  }
  sql += ' WHERE id = ?';
  params.push(id);
  
  db.prepare(sql).run(...params);
  res.json({ success: true });
});

// 會員管理：刪除
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (req.params.id == req.session.userId) {
    return res.status(400).json({ error: '不能刪除自己' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// 分類管理：列表
app.get('/api/admin/categories', requireAdmin, (req, res) => {
  try {
    const categories = db.prepare(`
      SELECT c.*, COUNT(a.id) as album_count
      FROM categories c
      LEFT JOIN albums a ON c.id = a.category_id
      GROUP BY c.id
      ORDER BY c.sort_order
    `).all();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 分類管理：新增
app.post('/api/admin/categories', requireAdmin, [
  body('name').trim().notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { name } = req.body;
  const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM categories').get().max || 0;
  
  try {
    const result = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)')
      .run(name, maxOrder + 1);
    res.json({ id: result.lastInsertRowid, name, sort_order: maxOrder + 1 });
  } catch (err) {
    res.status(400).json({ error: '分類名稱已存在' });
  }
});

// 分類管理：更新
app.put('/api/admin/categories/:id', requireAdmin, [
  body('name').trim().notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { name, sortOrder } = req.body;
  try {
    if (sortOrder !== undefined) {
      db.prepare('UPDATE categories SET name = ?, sort_order = ? WHERE id = ?')
        .run(name, sortOrder, req.params.id);
    } else {
      db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, req.params.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: '更新失敗' });
  }
});

// 分類管理：刪除
app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const albums = db.prepare('SELECT COUNT(*) as count FROM albums WHERE category_id = ?')
    .get(req.params.id).count;
  if (albums > 0) {
    return res.status(400).json({ error: '請先刪除或移轉該分類下的所有相簿' });
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// 相簿管理：列表（含所有相簿）
app.get('/api/admin/albums', requireAdmin, (req, res) => {
  try {
    const albums = db.prepare(`
      SELECT a.*, c.name as category_name, u.username,
             p.filename as cover_filename,
             (SELECT COUNT(*) FROM photos WHERE album_id = a.id) as photo_count
      FROM albums a
      LEFT JOIN categories c ON a.category_id = c.id
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN photos p ON a.cover_photo_id = p.id
      ORDER BY a.created_at DESC
    `).all();
    res.json(albums);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 相簿管理：新增
app.post('/api/admin/albums', requireAdmin, [
  body('title').trim().notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { title, description, categoryId, isPublic } = req.body;
  
  const result = db.prepare(`
    INSERT INTO albums (title, description, category_id, is_public, user_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, description || null, categoryId || null, isPublic !== false ? 1 : 0, req.session.userId);
  
  res.json({ id: result.lastInsertRowid, title });
});

// 相簿管理：更新
app.put('/api/admin/albums/:id', requireAdmin, [
  body('title').trim().notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { title, description, categoryId, isPublic, coverPhotoId } = req.body;
  
  db.prepare(`
    UPDATE albums SET title = ?, description = ?, category_id = ?, 
                      is_public = ?, cover_photo_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, description || null, categoryId || null, 
         isPublic !== false ? 1 : 0, coverPhotoId || null, req.params.id);
  
  res.json({ success: true });
});

// 相簿管理：刪除
app.delete('/api/admin/albums/:id', requireAdmin, (req, res) => {
  const photos = db.prepare('SELECT filename FROM photos WHERE album_id = ?').all(req.params.id);
  
  // 刪除檔案
  photos.forEach(p => {
    const originalPath = path.join(originalsDir, p.filename);
    const thumbPath = path.join(thumbnailsDir, p.filename);
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  });
  
  db.prepare('DELETE FROM albums WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// 相片管理：上傳多張
app.post('/api/admin/albums/:id/photos', requireAdmin, upload.array('photos', 50), async (req, res) => {
  try {
    const albumId = req.params.id;
    const album = db.prepare('SELECT * FROM albums WHERE id = ?').get(albumId);
    if (!album) return res.status(404).json({ error: '相簿不存在' });
    
    const results = [];
    for (const file of req.files) {
      // 生成縮圖
      await generateThumbnail(file.filename);
      
      // 寫入資料庫
      const maxOrder = db.prepare('SELECT MAX(sort_order) as max FROM photos WHERE album_id = ?')
        .get(albumId).max || 0;
      
      const result = db.prepare(`
        INSERT INTO photos (album_id, filename, original_name, sort_order)
        VALUES (?, ?, ?, ?)
      `).run(albumId, file.filename, file.originalname, maxOrder + 1);
      
      results.push({
        id: result.lastInsertRowid,
        filename: file.filename,
        originalName: file.originalname
      });
    }
    
    // 如果相簿還沒設封面，自動設為第一張
    if (!album.cover_photo_id && results.length > 0) {
      db.prepare('UPDATE albums SET cover_photo_id = ? WHERE id = ?')
        .run(results[0].id, albumId);
    }
    
    res.json({ success: true, photos: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 相片管理：更新照片
app.put('/api/admin/photos/:id', requireAdmin, (req, res) => {
  const { description, sortOrder, albumId } = req.body;
  
  if (description !== undefined) {
    db.prepare('UPDATE photos SET description = ? WHERE id = ?').run(description, req.params.id);
  }
  if (sortOrder !== undefined) {
    db.prepare('UPDATE photos SET sort_order = ? WHERE id = ?').run(sortOrder, req.params.id);
  }
  if (albumId !== undefined) {
    db.prepare('UPDATE photos SET album_id = ? WHERE id = ?').run(albumId, req.params.id);
  }
  
  res.json({ success: true });
});

// 相片管理：批次刪除
app.post('/api/admin/photos/batch-delete', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: '請提供要刪除的ID列表' });
  
  const photos = db.prepare(`SELECT * FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  
  photos.forEach(p => {
    const originalPath = path.join(originalsDir, p.filename);
    const thumbPath = path.join(thumbnailsDir, p.filename);
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  });
  
  db.prepare(`DELETE FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  res.json({ success: true });
});

// 相片管理：更新排序
app.post('/api/admin/albums/:id/photos/reorder', requireAdmin, (req, res) => {
  const { orderedIds } = req.body;
  if (!orderedIds || !Array.isArray(orderedIds)) {
    return res.status(400).json({ error: '請提供排序後的ID列表' });
  }
  
  const stmt = db.prepare('UPDATE photos SET sort_order = ? WHERE id = ?');
  orderedIds.forEach((id, index) => {
    stmt.run(index, id);
  });
  
  res.json({ success: true });
});

// 錯誤處理
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '伺服器錯誤' });
});

// 啟動
app.listen(PORT, () => {
  console.log(`✅ 電子相簿系統已啟動 http://localhost:${PORT}`);
  console.log(`📁 管理後台 http://localhost:${PORT}/admin`);
  console.log(`🔐 預設管理員帳號: admin / admin123`);
});
