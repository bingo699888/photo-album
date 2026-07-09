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
const { initDatabase, prepare, saveDatabase, getPool } = require('./database');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const PORT = process.env.PORT || 3000;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '1327985524250eda29220ae0a7e2aa10';
const CATBOX_API_URL = 'https://catbox.moe/user/api.php';

// Backblaze B2 S3 Config
const B2_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com';
const B2_REGION = 'us-east-005';
const B2_BUCKET = process.env.B2_BUCKET || 'bingo0970-';
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APP_KEY;

let s3Client = null;
function getS3Client() {
  if (!s3Client && B2_KEY_ID && B2_APP_KEY) {
    s3Client = new S3Client({
      region: B2_REGION,
      endpoint: B2_ENDPOINT,
      credentials: {
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APP_KEY,
      },
    });
  }
  return s3Client;
}

// 上傳檔案到 B2
async function uploadToB2(buffer, filename, contentType) {
  const s3 = getS3Client();
  if (!s3) {
    throw new Error('B2 未設定，請確認 B2_KEY_ID 和 B2_APP_KEY 環境變數');
  }
  const key = `photos/${Date.now()}-${filename}`;
  await s3.send(new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: 'authenticated-read',
  }));
  // 回傳公開 URL
  return `https://${B2_BUCKET}.s3.us-east-005.backblazeb2.com/${key}`;
}

// 上傳檔案到 Catbox（給 Banner 用）
async function uploadToCatbox(buffer, filename) {
  const FormData = require('form-data');
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', buffer, { filename });
  const response = await axios.post(CATBOX_API_URL, form, {
    headers: form.getHeaders(),
    maxBodyLength: 50 * 1024 * 1024
  });
  const url = response.data.trim();
  if (url.includes('catbox.moe')) return url;
  throw new Error('Catbox upload failed: ' + url);
}

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
const bannersDir = path.join(uploadsDir, 'banners');
[uploadsDir, originalsDir, thumbnailsDir, bannersDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Multer 設定（使用記憶體，之後上傳到 B2）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('只允許上傳圖片檔案 (jpg, png, gif, webp)'));
  }
});

// 生成縮圖（從 buffer）
async function generateThumbnailFromBuffer(buffer) {
  try {
    const image = await Jimp.read(buffer);
    image.cover(400, 400);
    image.quality(80);
    return await image.getBufferAsync('image/jpeg');
  } catch (err) {
    console.error('生成縮圖失敗:', err);
    return null;
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

app.get('/api/categories', async (req, res) => {
  try {
    // 非管理員看不到 admin-only 的分類
    const isAdmin = req.session.role === 'admin';
    const categories = await prepare(`
      SELECT c.*, COUNT(a.id) as album_count
      FROM categories c
      LEFT JOIN albums a ON c.id = a.category_id AND a.is_public = 1
      ${isAdmin ? '' : 'WHERE c.is_admin_only = 0'}
      GROUP BY c.id
      ORDER BY c.sort_order
    `).all();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Settings API
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await prepare('SELECT key, value FROM settings').all();
    const result = {};
    settings.forEach(s => result[s.key] = s.value);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: '缺少 key 或 value' });
    await prepare('INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)').run(key, value);
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
    const bannerFilename = 'banner-' + Date.now() + path.extname(req.file.originalname);
    const bannerPath = path.join(bannersDir, bannerFilename);
    fs.writeFileSync(bannerPath, req.file.buffer);
    const bannerUrl = '/uploads/banners/' + bannerFilename;
    await prepare('INSERT OR REPLACE INTO settings (key, value) VALUES ($1, $2)').run('banner_url', bannerUrl);
    res.json({ success: true, url: bannerUrl });
  } catch (err) {
    console.error('Banner upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/albums', async (req, res) => {
  try {
    const { category_id, search, page = 1, limit = 12 } = req.query;
    const offset = (page - 1) * limit;
    const params = [];
    let where = 'WHERE a.is_public = 1';
    if (category_id) {
      where += ' AND a.category_id = $' + (params.length + 1);
      params.push(Number(category_id));
    }
    if (search) {
      where += ' AND (a.title ILIKE $' + (params.length + 1) + ' OR a.description ILIKE $' + (params.length + 2) + ')';
      params.push(`%${search}%`, `%${search}%`);
    }
    const total = (await prepare(`SELECT COUNT(*)::int as count FROM albums a ${where}`).get(...params)).count;
    const queryParams = [...params, Number(limit), Number(offset)];
    const albums = await prepare(`
      SELECT a.*, c.name as category_name, p.filename as cover_filename,
             (SELECT COUNT(*)::int FROM photos WHERE album_id = a.id) as photo_count
      FROM albums a
      LEFT JOIN categories c ON a.category_id = c.id
      LEFT JOIN photos p ON a.cover_photo_id = p.id
      ${where}
      ORDER BY a.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `).all(...queryParams);
    res.json({ albums, total, page: Number(page), totalPages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/albums/:id', async (req, res) => {
  try {
    const album = await prepare(`
      SELECT a.*, c.name as category_name
      FROM albums a
      LEFT JOIN categories c ON a.category_id = c.id
      WHERE a.id = $1 AND a.is_public = 1
    `).get(req.params.id);
    if (!album) return res.status(404).json({ error: '相簿不存在' });
    const photos = await prepare(`SELECT * FROM photos WHERE album_id = $1 ORDER BY sort_order, uploaded_at`)
      .all(req.params.id);
    res.json({ ...album, photos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/photos/:id', async (req, res) => {
  try {
    const photo = await prepare('SELECT * FROM photos WHERE id = $1').get(req.params.id);
    if (!photo) return res.status(404).json({ error: '照片不存在' });
    res.json(photo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/thumbnails/:filename', async (req, res) => {
  const thumbName = req.params.filename.replace(/\.([^.]+)$/, '.jpg');
  const photo = await prepare('SELECT thumbnail_url FROM photos WHERE filename = $1').get(thumbName);
  if (photo && photo.thumbnail_url) {
    return res.redirect(photo.thumbnail_url);
  }
  // 找不到時回 404
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

app.get('/uploads/banners/:filename', (req, res) => {
  const filePath = path.join(bannersDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('找不到檔案');
  }
});

app.get('/api/photos/:id/download', requireLogin, async (req, res) => {
  const photo = await prepare('SELECT * FROM photos WHERE id = $1').get(req.params.id);
  if (!photo) return res.status(404).json({ error: '照片不存在' });
  const filePath = path.join(originalsDir, photo.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '檔案不存在' });
  res.download(filePath, photo.original_name || photo.filename);
});

app.get('/api/albums/:id/download', requireLogin, async (req, res) => {
  const photos = await prepare('SELECT * FROM photos WHERE album_id = $1 ORDER BY sort_order').all(req.params.id);
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
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { username, password } = req.body;
  const user = await prepare('SELECT * FROM users WHERE username = $1 AND is_active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.displayName = user.display_name;
  res.json({ id: user.id, username: user.username, displayName: user.display_name, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  res.json({ id: req.session.userId, username: req.session.username, displayName: req.session.displayName, role: req.session.role });
});

app.post('/api/auth/change-password', requireLogin, [
  body('oldPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { oldPassword, newPassword } = req.body;
  const user = await prepare('SELECT * FROM users WHERE id = $1').get(req.session.userId);
  if (!bcrypt.compareSync(oldPassword, user.password)) {
    return res.status(400).json({ error: '舊密碼錯誤' });
  }
  const hashed = bcrypt.hashSync(newPassword, 10);
  await prepare('UPDATE users SET password = $1 WHERE id = $2').run(hashed, req.session.userId);
  res.json({ success: true });
});

app.put('/api/auth/profile', requireLogin, [
  body('displayName').optional().trim(),
  body('email').optional().isEmail()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { displayName, email } = req.body;
  await prepare('UPDATE users SET display_name = $1, email = $2 WHERE id = $3')
    .run(displayName || null, email || null, req.session.userId);
  req.session.displayName = displayName;
  res.json({ success: true });
});

// ===== 管理後台 API =====

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await prepare(`
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
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { username, password, displayName, email, role } = req.body;
  const existing = await prepare('SELECT id FROM users WHERE username = $1').get(username);
  if (existing) return res.status(400).json({ error: '帳號已存在' });
  const hashed = bcrypt.hashSync(password, 10);
  const result = await prepare(`
    INSERT INTO users (username, password, display_name, email, role)
    VALUES ($1, $2, $3, $4, $5)
  `).run(username, hashed, displayName || null, email || null, role);
  res.json({ id: result.lastInsertRowid, username, displayName, email, role });
});

app.put('/api/admin/users/:id', requireAdmin, [
  body('role').optional().isIn(['admin', 'member'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { id } = req.params;
  const { displayName, email, role, isActive, password } = req.body;
  const user = await prepare('SELECT * FROM users WHERE id = $1').get(id);
  if (!user) return res.status(404).json({ error: '會員不存在' });
  if (password) {
    const hashed = bcrypt.hashSync(password, 10);
    await prepare('UPDATE users SET display_name = $1, email = $2, role = $3, is_active = $4, password = $5 WHERE id = $6')
      .run(displayName || user.display_name, email || user.email, role || user.role,
           isActive !== undefined ? (isActive ? 1 : 0) : user.is_active, hashed, id);
  } else {
    await prepare('UPDATE users SET display_name = $1, email = $2, role = $3, is_active = $4 WHERE id = $5')
      .run(displayName || user.display_name, email || user.email, role || user.role,
           isActive !== undefined ? (isActive ? 1 : 0) : user.is_active, id);
  }
  res.json({ success: true });
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  if (req.params.id == req.session.userId) {
    return res.status(400).json({ error: '不能刪除自己' });
  }
  await prepare('DELETE FROM users WHERE id = $1').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/categories', requireAdmin, async (req, res) => {
  try {
    const categories = await prepare(`
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
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { name, isAdminOnly } = req.body;
  try {
    const row = await prepare('SELECT MAX(sort_order)::int as max FROM categories').get();
    const maxOrder = row.max || 0;
    const result = await prepare('INSERT INTO categories (name, sort_order, is_admin_only) VALUES ($1, $2, $3)')
      .run(name, maxOrder + 1, isAdminOnly ? 1 : 0);
    res.json({ id: result.lastInsertRowid, name, sort_order: maxOrder + 1, is_admin_only: isAdminOnly ? 1 : 0 });
  } catch (err) {
    res.status(400).json({ error: '分類名稱已存在' });
  }
});

app.put('/api/admin/categories/:id', requireAdmin, [
  body('name').trim().notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { name, sortOrder, isAdminOnly } = req.body;
  try {
    if (sortOrder !== undefined) {
      await prepare('UPDATE categories SET name = $1, sort_order = $2, is_admin_only = $3 WHERE id = $4')
        .run(name, sortOrder, isAdminOnly ? 1 : 0, req.params.id);
    } else {
      await prepare('UPDATE categories SET name = $1, is_admin_only = $2 WHERE id = $3')
        .run(name, isAdminOnly ? 1 : 0, req.params.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: '更新失敗' });
  }
});

app.delete('/api/admin/categories/:id', requireAdmin, async (req, res) => {
  const row = await prepare('SELECT COUNT(*)::int as count FROM albums WHERE category_id = $1')
    .get(req.params.id);
  if (row.count > 0) {
    return res.status(400).json({ error: '請先刪除或移轉該分類下的所有相簿' });
  }
  await prepare('DELETE FROM categories WHERE id = $1').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/albums', requireAdmin, async (req, res) => {
  try {
    const albums = await prepare(`
      SELECT a.*, c.name as category_name, u.username,
             p.filename as cover_filename,
             (SELECT COUNT(*)::int FROM photos WHERE album_id = a.id) as photo_count
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
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { title, description, categoryId, isPublic } = req.body;
  const result = await prepare(`
    INSERT INTO albums (title, description, category_id, is_public, user_id)
    VALUES ($1, $2, $3, $4, $5)
  `).run(title, description || null, categoryId || null, isPublic !== false ? 1 : 0, req.session.userId);
  res.json({ id: result.lastInsertRowid, title });
});

app.put('/api/admin/albums/:id', requireAdmin, [
  body('title').trim().notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  const { title, description, categoryId, isPublic, coverPhotoId } = req.body;
  await prepare(`
    UPDATE albums SET title = $1, description = $2, category_id = $3,
                      is_public = $4, cover_photo_id = $5, updated_at = CURRENT_TIMESTAMP
    WHERE id = $6
  `).run(title, description || null, categoryId || null,
         isPublic !== false ? 1 : 0, coverPhotoId || null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/albums/:id', requireAdmin, async (req, res) => {
  const photos = await prepare('SELECT filename FROM photos WHERE album_id = $1').all(req.params.id);
  photos.forEach(p => {
    const originalPath = path.join(originalsDir, p.filename);
    const thumbPath = path.join(thumbnailsDir, p.filename);
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  });
  await prepare('DELETE FROM albums WHERE id = $1').run(req.params.id);
  res.json({ success: true });
});

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
  if (url.includes('catbox.moe')) return url;
  throw new Error('Catbox upload failed: ' + url);
}

app.post('/api/admin/albums/:id/photos', requireAdmin, upload.array('photos', 50), async (req, res) => {
  try {
    const albumId = req.params.id;
    const album = await prepare('SELECT * FROM albums WHERE id = $1').get(albumId);
    if (!album) return res.status(404).json({ error: '相簿不存在' });
    const results = [];
    for (const file of req.files) {
      // 上傳原圖到 B2
      const photoUrl = await uploadToB2(file.buffer, file.originalname, file.mimetype);
      // 生成縮圖（從 buffer）
      const thumbBuffer = await generateThumbnailFromBuffer(file.buffer);
      const thumbFilename = file.originalname.replace(/\.([^.]+)$/, '.jpg');
      const thumbUrl = await uploadToB2(thumbBuffer, thumbFilename, 'image/jpeg');
      const row = await prepare('SELECT MAX(sort_order)::int as max FROM photos WHERE album_id = $1')
        .get(albumId);
      const maxOrder = row.max || 0;
      const result = await prepare(`
        INSERT INTO photos (album_id, filename, original_name, sort_order, imgbb_url, thumbnail_url)
        VALUES ($1, $2, $3, $4, $5, $6)
      `).run(albumId, thumbFilename, file.originalname, maxOrder + 1, photoUrl, thumbUrl);
      results.push({ id: result.lastInsertRowid, filename: thumbFilename, originalName: file.originalname, url: photoUrl, thumbnailUrl: thumbUrl });
    }
    if (!album.cover_photo_id && results.length > 0) {
      await prepare('UPDATE albums SET cover_photo_id = $1 WHERE id = $2')
        .run(results[0].id, albumId);
    }
    res.json({ success: true, photos: results });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/photos/:id', requireAdmin, async (req, res) => {
  const { description, sortOrder, albumId } = req.body;
  if (description !== undefined) {
    await prepare('UPDATE photos SET description = $1 WHERE id = $2').run(description, req.params.id);
  }
  if (sortOrder !== undefined) {
    await prepare('UPDATE photos SET sort_order = $1 WHERE id = $2').run(sortOrder, req.params.id);
  }
  if (albumId !== undefined) {
    await prepare('UPDATE photos SET album_id = $1 WHERE id = $2').run(albumId, req.params.id);
  }
  res.json({ success: true });
});

app.post('/api/admin/photos/batch-delete', requireAdmin, async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: '請提供要刪除的ID列表' });
  const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
  const photos = await prepare(`SELECT * FROM photos WHERE id IN (${placeholders})`).all(...ids);
  photos.forEach(p => {
    const originalPath = path.join(originalsDir, p.filename);
    const thumbPath = path.join(thumbnailsDir, p.filename);
    if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  });
  await prepare(`DELETE FROM photos WHERE id IN (${placeholders})`).run(...ids);
  res.json({ success: true });
});

app.post('/api/admin/albums/:id/photos/reorder', requireAdmin, async (req, res) => {
  const { orderedIds } = req.body;
  if (!orderedIds || !Array.isArray(orderedIds)) {
    return res.status(400).json({ error: '請提供排序後的ID列表' });
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await prepare('UPDATE photos SET sort_order = $1 WHERE id = $2').run(i, orderedIds[i]);
  }
  res.json({ success: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || '伺服器錯誤' });
});

// 一次性修復路由：任何人只要知道這個 URL 就能修 admin role
app.get('/fix-admin-role', async (req, res) => {
  try {
    const client = await getPool().connect();
    try {
      const result = await client.query(`
        UPDATE users SET role = 'admin'
        WHERE username = 'admin' AND role != 'admin'
        RETURNING id, username, role
      `);
      if (result.rowCount > 0) {
        res.send(`✅ 修復成功！ ${result.rowCount} 個帳號已更新: ${JSON.stringify(result.rows)}`);
      } else {
        res.send('✅ admin 帳號角色已經正確，無需修改');
      }
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).send('❌ 修復失敗: ' + err.message);
  }
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
