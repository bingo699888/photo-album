const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const Jimp = require('jimp');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const { body, validationResult } = require('express-validator');
const axios = require('axios');
const { initDatabase, prepare, saveDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '1327985524250eda29220ae0a7e2aa10';
const CATBOX_API_URL = 'https://catbox.moe/user/api.php';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Session 設定
const session = require('express-session');
app.use(session({
  proxy: true,
  secret: process.env.SESSION_SECRET || 'photo-album-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
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
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('只允許上傳圖片檔案 (jpg, png, gif, webp)'));
  }
});

// 生成縮圖
async function generateThumbnail(filename) {
  const inputPath = path.join(originalsDir, filename);
  const outputPath = path.join(thumbnailsDir, filename);
  try {
    const image = await Jimp.read(inputPath);
    image.cover(400, 400);
    image.quality(80);
    await image.writeAsync(outputPath.replace(/.([a-z]+)$/, '.jpg'));
  } catch (err) {
    console.error('生成縮圖失敗:', err);
  }
}

// ===== 中介層 =====

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: '請先登入' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理員權限' });
  }
  next();
}

// ===== 前台 API =====

app.get('/api/categories', (req, res) => {
  try {
    const categories = prepare(`
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

// Settings API
app.get('/api/settings', (req, res) => {
  try {
    const settings = prepare('SELECT key, value FROM settings').all();
    const result = {};
    settings.forEach(s => result[s.key] = s.value);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: '缺少 key 或 value' });
    prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Banner upload to Catbox
const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('只支援圖片檔案'));
  }
});

app.post('/api/admin/banner', requireAdmin, bannerUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '沒有上傳檔案' });
    
    // Use native https to avoid axios/form-data issues on Railway
    const { URL } = require('url');
    const https = require('https');
    
    const boundary = '----FormBoundary' + Math.random().toString(36).substring(2);
    const buf = req.file.buffer;
    
    const bodyParts = [
      `--${boundary}\r
Content-Disposition: form-data; name="reqtype"\r

fileupload`,
      `--${boundary}\r
Content-Disposition: form-data; name="fileToUpload"; filename="${req.file.originalname}"\r
Content-Type: ${req.file.mimetype}\r

`
    ];
    
    const bodyEnd = `\r
--${boundary}--\r
`;
    
    const bodyStart = Buffer.from(bodyParts.join(''));
    const bodyEndBuf = Buffer.from(bodyEnd);
    const bodyLen = bodyStart.length + buf.length + bodyEndBuf.length;
    
    const options = new URL(CATBOX_API_URL);
    options.method = 'POST';
    options.headers = {
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': bodyLen
    };
    
    const result = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data.trim());
          } else {
            reject(new Error(`Catbox returned ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.write(bodyStart);
      req.write(buf);
      req.write(bodyEndBuf);
      req.end();
    });

    if (!result.includes('catbox.moe')) {
      throw new Error('Catbox upload failed: ' + result);
    }

    // Save banner URL to settings
    prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('banner_url', result);
    res.json({ success: true, url: result });
  } catch (err) {
    console.error('Banner upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/albums', (req, res) => {
  try {
    const { category_id, search, page = 1, limit = 12 } = req.query;
    const offset = (page - 1) * limit;
    
    let where = 'WHERE a.is_public = 1';
    const params = [];
    
    if (category_id) {
      where += ' AND a.category_id = ?';
      params.push(Number(category_id));
    }
    if (search) {
      where += ' AND (a.title LIKE ? OR a.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    const total = prepare(`SELECT COUNT(*) as count FROM albums a ${where}`).get(...params).count;
    
    const albums = prepare(`
      SELECT a.*, c.name as category_name, p.filename as cover_filename,
      (SELECT COUNT(*) FROM photos WHERE album_id = a.id) as photo_count
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

app.get('/api/albums/:id', (req, res) => {
  try {
    const album = prepare(`
      SELECT a.*, c.name as category_name
      FROM albums a
      LEFT JOIN categories c ON a.category_id = c.id
      WHERE a.id = ? AND a.is_public = 1
    `).get(req.params.id);
    
    if (!album) return res.status(404).json({ error: '相簿不存在' });
    
    const photos = prepare(`SELECT * FROM photos WHERE album_id = ? ORDER BY sort_order, uploaded_at`)
      .all(req.params.id);
    
    res.json({ ...album, photos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/photos/:id', (req, res) => {
  try {
    const photo = prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
    if (!photo) return res.status(404).json({ error: '照片不存在' });
    res.json(photo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/thumbnails/:filename', async (req, res) => {
  // 嘗試直接讀取本地縮圖檔案
  const thumbName = req.params.filename.replace(/\.([^.]+)$/, '.jpg');
  const thumbPath = path.join(thumbnailsDir, thumbName);
  if (fs.existsSync(thumbPath)) {
    return res.sendFile(thumbPath);
  }
  // 退而求其次：看 imgbb_url
  const photo = prepare('SELECT imgbb_url FROM photos WHERE filename = ?').get(req.params.filename);
  if (photo && photo.imgbb_url) {
    return res.redirect(photo.imgbb_url);
  }
  res.status(404).send('找不到縮圖');
});

app.get('/uploads/originals/:filename', requireLogin, (req, res) => {
  const filePath = path.join(originalsDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('找不到檔案');
  }
});

app.get('/api/photos/:id/download', requireLogin, (req, res) => {
  const photo = prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id);
  if (!photo) return res.status(404).json({ error: '照片不存在' });
  
  const filePath = path.join(originalsDir, photo.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '檔案不存在' });
  
  res.download(filePath, photo.original_name || photo.filename);
});

app.get('/api/albums/:id/download', requireLogin, (req, res) => {
  const photos = prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY sort_order').all(req.params.id);
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

app.post('/api/auth/login', [
  body('username').trim().notEmpty(),
  body('password').notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { username, password } = req.body;
  const user = prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  
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

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  res.json({
    id: req.session.userId,
    username: req.session.username,
    displayName: req.session.displayName,
    role: req.session.role
  });
});

app.post('/api/auth/change-password', requireLogin, [
  body('oldPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 })
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { oldPassword, newPassword } = req.body;
  const user = prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  
  if (!bcrypt.compareSync(oldPassword, user.password)) {
    return res.status(400).json({ error: '舊密碼錯誤' });
  }
  
  const hashed = bcrypt.hashSync(newPassword, 10);
  prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, req.session.userId);
  
  res.json({ success: true });
});

app.put('/api/auth/profile', requireLogin, [
  body('displayName').optional().trim(),
  body('email').optional().isEmail()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { displayName, email } = req.body;
  prepare('UPDATE users SET display_name = ?, email = ? WHERE id = ?')
    .run(displayName || null, email || null, req.session.userId);
  
  req.session.displayName = displayName;
  res.json({ success: true });
});

// ===== 管理後台 API =====

app.get('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const users = prepare(`
      SELECT id, username, display_name, email, role, is_active, created_at
      FROM users ORDER BY created_at DESC
    `).all();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users', requireAdmin, [
  body('username').trim().notEmpty().isLength({ min: 3 }),
  body('password').isLength({ min: 6 }),
  body('role').isIn(['admin', 'member'])
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { username, password, displayName, email, role } = req.body;
  
  const existing = prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: '帳號已存在' });
  
  const hashed = bcrypt.hashSync(password, 10);
  const result = prepare(`
    INSERT INTO users (username, password, display_name, email, role)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, hashed, displayName || null, email || null, role);
  
  res.json({ id: result.lastInsertRowid, username, displayName, email, role });
});

app.put('/api/admin/users/:id', requireAdmin, [
  body('role').optional().isIn(['admin', 'member'])
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { id } = req.params;
  const { displayName, email, role, isActive, password } = req.body;
  
  const user = prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: '會員不存在' });
  
  if (password) {
    const hashed = bcrypt.hashSync(password, 10);
    prepare('UPDATE users SET display_name = ?, email = ?, role = ?, is_active = ?, password = ? WHERE id = ?')
      .run(displayName || user.display_name, email || user.email, role || user.role, 
           isActive !== undefined ? (isActive ? 1 : 0) : user.is_active, hashed, id);
  } else {
    prepare('UPDATE users SET display_name = ?, email = ?, role = ?, is_active = ? WHERE id = ?')
      .run(displayName || user.display_name, email || user.email, role || user.role, 
           isActive !== undefined ? (isActive ? 1 : 0) : user.is_active, id);
  }
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  if (req.params.id == req.session.userId) {
    return res.status(400).json({ error: '不能刪除自己' });
  }
  prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/categories', requireAdmin, (req, res) => {
  try {
    const categories = prepare(`
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

app.post('/api/admin/categories', requireAdmin, [
  body('name').trim().notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { name } = req.body;
  const maxOrder = prepare('SELECT MAX(sort_order) as max FROM categories').get().max || 0;
  
  try {
    const result = prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)')
      .run(name, maxOrder + 1);
    res.json({ id: result.lastInsertRowid, name, sort_order: maxOrder + 1 });
  } catch (err) {
    res.status(400).json({ error: '分類名稱已存在' });
  }
});

app.put('/api/admin/categories/:id', requireAdmin, [
  body('name').trim().notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { name, sortOrder } = req.body;
  try {
    if (sortOrder !== undefined) {
      prepare('UPDATE categories SET name = ?, sort_order = ? WHERE id = ?')
        .run(name, sortOrder, req.params.id);
    } else {
      prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, req.params.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: '更新失敗' });
  }
});

app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const albums = prepare('SELECT COUNT(*) as count FROM albums WHERE category_id = ?')
    .get(req.params.id).count;
  if (albums > 0) {
    return res.status(400).json({ error: '請先刪除或移轉該分類下的所有相簿' });
  }
  prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/albums', requireAdmin, (req, res) => {
  try {
    const albums = prepare(`
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

app.post('/api/admin/albums', requireAdmin, [
  body('title').trim().notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { title, description, categoryId, isPublic } = req.body;
  
  const result = prepare(`
    INSERT INTO albums (title, description, category_id, is_public, user_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, description || null, categoryId || null, isPublic !== false ? 1 : 0, req.session.userId);
  
  res.json({ id: result.lastInsertRowid, title });
});

app.put('/api/admin/albums/:id', requireAdmin, [
  body('title').trim().notEmpty()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  
  const { title, description, categoryId, isPublic, coverPhotoId } = req.body;
  
  prepare(`
    UPDATE albums SET title = ?, description = ?, category_id = ?, 
                      is_public = ?, cover_photo_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(title, description || null, categoryId || null, 
         isPublic !== false ? 1 : 0, coverPhotoId || null, req.params.id);
  
  res.json({ success: true });
});

app.delete('/api/admin/albums/:id', requireAdmin, (req, res) => {
  const photos = prepare('SELECT filename FROM photos WHERE album_id = ?').all(req.params.id);
  
  photos.forEach(p => {
    const originalPath = path.join(originalsDir, p.filename);
    const thumbPath = path.join(thumbnailsDir, p.filename);
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  });
  
  prepare('DELETE FROM albums WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ImgBB upload helper (deprecated - kept for migration)
async function uploadToImgBB(fileBuffer, filename) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('image', fileBuffer.toString('base64'));
  form.append('name', filename);
  
  const response = await axios.post('https://api.imgbb.com/1/upload', form, {
    params: { key: IMGBB_API_KEY },
    headers: form.getHeaders()
  });
  
  if (response.data.success) {
    return response.data.data.url;
  }
  throw new Error('ImgBB upload failed');
}

// Catbox upload helper
async function uploadToCatbox(filePath, filename) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', fs.createReadStream(filePath));
  
  const response = await axios.post(CATBOX_API_URL, form, {
    headers: form.getHeaders(),
    maxBodyLength: 50 * 1024 * 1024
  });
  
  const url = response.data.trim();
  if (url.includes('catbox.moe')) {
    return url;
  }
  throw new Error('Catbox upload failed: ' + url);
}

app.post('/api/admin/albums/:id/photos', requireAdmin, upload.array('photos', 50), async (req, res) => {
  try {
    const albumId = req.params.id;
    const album = prepare('SELECT * FROM albums WHERE id = ?').get(albumId);
    if (!album) return res.status(404).json({ error: '相簿不存在' });
    
    const results = [];
    for (const file of req.files) {
      const filePath = file.path;
      
      // 上傳到 Catbox
      const catboxUrl = await uploadToCatbox(filePath, file.filename);

      // 生成縮圖（儲存當地，讓前台載入更快）
      await generateThumbnail(file.filename);

      // 刪除本機檔案（節省空間）
      fs.unlinkSync(filePath);
      
      const maxOrder = prepare('SELECT MAX(sort_order) as max FROM photos WHERE album_id = ?')
        .get(albumId).max || 0;
      
      const result = prepare(`
        INSERT INTO photos (album_id, filename, original_name, sort_order, imgbb_url)
        VALUES (?, ?, ?, ?, ?)
      `).run(albumId, file.filename, file.originalname, maxOrder + 1, catboxUrl);
      
      results.push({
        id: result.lastInsertRowid,
        filename: file.filename,
        originalName: file.originalname,
        url: catboxUrl
      });
    }
    
    if (!album.cover_photo_id && results.length > 0) {
      prepare('UPDATE albums SET cover_photo_id = ? WHERE id = ?')
        .run(results[0].id, albumId);
    }
    
    res.json({ success: true, photos: results });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/photos/:id', requireAdmin, (req, res) => {
  const { description, sortOrder, albumId } = req.body;
  
  if (description !== undefined) {
    prepare('UPDATE photos SET description = ? WHERE id = ?').run(description, req.params.id);
  }
  if (sortOrder !== undefined) {
    prepare('UPDATE photos SET sort_order = ? WHERE id = ?').run(sortOrder, req.params.id);
  }
  if (albumId !== undefined) {
    prepare('UPDATE photos SET album_id = ? WHERE id = ?').run(albumId, req.params.id);
  }
  
  res.json({ success: true });
});

app.post('/api/admin/photos/batch-delete', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: '請提供要刪除的ID列表' });
  
  const placeholders = ids.map(() => '?').join(',');
  const photos = prepare(`SELECT * FROM photos WHERE id IN (${placeholders})`).all(...ids);
  
  photos.forEach(p => {
    const originalPath = path.join(originalsDir, p.filename);
    const thumbPath = path.join(thumbnailsDir, p.filename);
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  });
  
  prepare(`DELETE FROM photos WHERE id IN (${placeholders})`).run(...ids);
  res.json({ success: true });
});

app.post('/api/admin/albums/:id/photos/reorder', requireAdmin, (req, res) => {
  const { orderedIds } = req.body;
  if (!orderedIds || !Array.isArray(orderedIds)) {
    return res.status(400).json({ error: '請提供排序後的ID列表' });
  }
  
  orderedIds.forEach((id, index) => {
    prepare('UPDATE photos SET sort_order = ? WHERE id = ?').run(index, id);
  });
  
  res.json({ success: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '伺服器錯誤' });
});

// 啟動
async function start() {
  await initDatabase();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ 電子相簿系統已啟動 http://localhost:${PORT}`);
    console.log(`📁 管理後台 http://localhost:${PORT}/admin`);
    console.log(`🔐 預設管理員帳號: admin / admin123`);
  });
}

start().catch(err => {
  console.error('啟動失敗:', err);
  process.exit(1);
});
