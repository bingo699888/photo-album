// ===== State =====
let currentUser = null;
let users = [];
let albums = [];
let categories = [];
let currentAlbumId = null;
let currentPhotos = [];
let selectedPhotos = new Set();

// ===== API Helpers =====
const api = {
  async get(endpoint) {
    const res = await fetch(endpoint);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        redirectToLogin();
        throw new Error('無權限');
      }
      throw new Error(await res.text());
    }
    return res.json();
  },
  async post(endpoint, data) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || err.errors?.[0]?.msg);
    }
    return res.json();
  },
  async put(endpoint, data) {
    const res = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || err.errors?.[0]?.msg);
    }
    return res.json();
  },
  async del(endpoint) {
    const res = await fetch(endpoint, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
  async upload(endpoint, formData) {
    const res = await fetch(endpoint, { method: 'POST', body: formData });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
};

function redirectToLogin() {
  if (window.location.pathname !== '/admin/index.html' && !window.location.pathname.endsWith('/admin/')) {
    window.location.href = '/admin/index.html';
  }
}

// ===== Auth =====
async function checkAuth() {
  try {
    currentUser = await api.get('/api/auth/me');
    if (!currentUser || currentUser.role !== 'admin') {
      redirectToLogin();
      return;
    }
    document.getElementById('userDisplay').textContent = currentUser.displayName || currentUser.username;
  } catch (e) {
    console.error('Auth check failed:', e);
    // Don't redirect on error, just log
  }
}

async function handleLogout() {
  await api.post('/api/auth/logout');
  window.location.href = '/';
}

// ===== Section Navigation =====
function showSection(name) {
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.admin-nav-item').forEach(n => n.classList.remove('active'));

  const sectionMap = {
    'users': 'usersSection',
    'albums': 'albumsSection',
    'album-detail': 'albumDetailSection',
    'categories': 'categoriesSection'
  };

  const section = document.getElementById(sectionMap[name]);
  if (section) section.classList.add('active');

  const navItem = document.querySelector(`.admin-nav-item[data-section="${name}"]`);
  if (navItem) navItem.classList.add('active');
}

// ===== Users Management =====
async function loadUsers() {
  users = await api.get('/api/admin/users');
  renderUsers();
}

function renderUsers() {
  const tbody = document.getElementById('usersTable');
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${u.username}</td>
      <td>${u.display_name || '-'}</td>
      <td>${u.email || '-'}</td>
      <td><span class="badge badge-${u.role}">${u.role === 'admin' ? '管理員' : '會員'}</span></td>
      <td>${u.is_active ? '✅ 啟用' : '❌ 停用'}</td>
      <td>${new Date(u.created_at).toLocaleDateString('zh-TW')}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="editUser(${u.id})">編輯</button>
        <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${u.username}')">刪除</button>
      </td>
    </tr>
  `).join('');
}

function openUserModal(user = null) {
  document.getElementById('userModalTitle').textContent = user ? '編輯會員' : '新增會員';
  document.getElementById('userId').value = user?.id || '';
  document.getElementById('userUsername').value = user?.username || '';
  document.getElementById('userUsername').disabled = !!user;
  document.getElementById('userPassword').value = '';
  document.getElementById('userPassword').required = !user;
  document.getElementById('passwordHint').style.display = user ? 'inline' : 'none';
  document.getElementById('userDisplayName').value = user?.display_name || '';
  document.getElementById('userEmail').value = user?.email || '';
  document.getElementById('userRole').value = user?.role || 'member';
  document.getElementById('userIsActive').checked = user ? !!user.is_active : true;
  document.getElementById('isActiveGroup').style.display = user ? 'block' : 'none';
  openModal('userModal');
}

async function editUser(id) {
  const user = users.find(u => u.id === id);
  if (user) openUserModal(user);
}

async function saveUser(e) {
  e.preventDefault();
  const id = document.getElementById('userId').value;
  const data = {
    displayName: document.getElementById('userDisplayName').value,
    email: document.getElementById('userEmail').value,
    role: document.getElementById('userRole').value
  };

  if (!id) {
    data.username = document.getElementById('userUsername').value;
    data.password = document.getElementById('userPassword').value;
  } else {
    const password = document.getElementById('userPassword').value;
    if (password) data.password = password;
    data.isActive = document.getElementById('userIsActive').checked;
  }

  try {
    if (id) {
      await api.put(`/api/admin/users/${id}`, data);
    } else {
      await api.post('/api/admin/users', data);
    }
    closeModal('userModal');
    showToast(id ? '會員已更新' : '會員已新增', 'success');
    loadUsers();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function deleteUser(id, username) {
  showConfirm(`確定要刪除會員「${username}」嗎？`, async () => {
    try {
      await api.del(`/api/admin/users/${id}`);
      showToast('會員已刪除', 'success');
      loadUsers();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

// ===== Albums Management =====
async function loadAlbums() {
  albums = await api.get('/api/admin/albums');
  renderAlbums();
}

function renderAlbums() {
  const grid = document.getElementById('adminAlbumsGrid');
  if (albums.length === 0) {
    grid.innerHTML = '<p class="text-light">還沒有相簿，點擊上方按鈕新增</p>';
    return;
  }

  grid.innerHTML = albums.map(album => `
    <div class="admin-album-card">
      <div class="album-cover">
        ${album.cover_filename
          ? `<img src="${album.cover_filename ? (album.cover_filename.startsWith('http') ? album.cover_filename : '/thumbnails/' + album.cover_filename) : '/css/placeholder.svg'}" alt="${album.title}">`
          : '<div style="background:#f1f5f9;height:100%;display:flex;align-items:center;justify-content:center;">📷</div>'
        }
      </div>
      <div class="info">
        <div style="font-weight:600;">${album.title}</div>
        <div class="text-sm text-light">${album.category_name || '未分類'} · ${album.photo_count || 0} 張</div>
        <div class="text-sm text-light">${album.is_public ? '✅ 公開' : '🔒 私人'}</div>
      </div>
      <div class="actions">
        <button class="btn btn-outline btn-sm" onclick="editAlbum(${album.id})">編輯</button>
        <button class="btn btn-secondary btn-sm" onclick="manageAlbumPhotos(${album.id}, '${album.title.replace(/'/g, "\\'")}')">照片</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAlbum(${album.id}, '${album.title.replace(/'/g, "\\'")}')">刪除</button>
      </div>
    </div>
  `).join('');
}

function openAlbumModal(album = null) {
  document.getElementById('albumModalTitle').textContent = album ? '編輯相簿' : '新增相簿';
  document.getElementById('albumId').value = album?.id || '';
  document.getElementById('albumTitle').value = album?.title || '';
  document.getElementById('albumDescription').value = album?.description || '';
  document.getElementById('albumIsPublic').checked = album ? !!album.is_public : true;

  // Load categories for dropdown
  loadCategoriesForSelect();

  if (album) {
    document.getElementById('albumCategoryId').value = album.category_id || '';
  }

  openModal('albumModal');
}

async function loadCategoriesForSelect() {
  const cats = await api.get('/api/admin/categories');
  document.getElementById('albumCategoryId').innerHTML =
    '<option value="">未分類</option>' +
    cats.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
}

function editAlbum(id) {
  const album = albums.find(a => a.id === id);
  if (album) openAlbumModal(album);
}

async function saveAlbum(e) {
  e.preventDefault();
  const id = document.getElementById('albumId').value;
  const data = {
    title: document.getElementById('albumTitle').value,
    description: document.getElementById('albumDescription').value,
    categoryId: document.getElementById('albumCategoryId').value || null,
    isPublic: document.getElementById('albumIsPublic').checked
  };

  try {
    if (id) {
      await api.put(`/api/admin/albums/${id}`, data);
    } else {
      await api.post('/api/admin/albums', data);
    }
    closeModal('albumModal');
    showToast(id ? '相簿已更新' : '相簿已新增', 'success');
    loadAlbums();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function deleteAlbum(id, title) {
  showConfirm(`確定要刪除相簿「${title}」嗎？所有照片也會一併刪除。`, async () => {
    try {
      await api.del(`/api/admin/albums/${id}`);
      showToast('相簿已刪除', 'success');
      loadAlbums();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

// ===== Photos Management =====
async function manageAlbumPhotos(albumId, title) {
  currentAlbumId = albumId;
  document.getElementById('albumDetailTitle').textContent = title;
  showSection('album-detail');
  await loadAlbumPhotos(albumId);
}

async function loadAlbumPhotos(albumId) {
  try {
    const album = await api.get(`/api/albums/${albumId}`);
    currentPhotos = album.photos;
    selectedPhotos.clear();
    updateBatchUI();
    renderPhotos();
  } catch (e) {
    showToast('載入照片失敗', 'error');
  }
}

function renderPhotos() {
  const grid = document.getElementById('adminPhotosGrid');

  if (currentPhotos.length === 0) {
    grid.innerHTML = '<p class="text-light">這個相簿還沒有照片，上傳一些吧！</p>';
    return;
  }

  grid.innerHTML = currentPhotos.map(photo => `
    <div class="admin-photo-card" data-id="${photo.id}">
      <input type="checkbox" class="checkbox" onchange="togglePhotoSelection(${photo.id})" ${selectedPhotos.has(photo.id) ? 'checked' : ''}>
      <img src="${photo.imgbb_url || '/thumbnails/' + photo.filename}" alt="">
      <div class="actions">
        <button onclick="editPhoto(${photo.id}, '${(photo.description || '').replace(/'/g, "\\'")}')">✏️</button>
        <button onclick="deletePhoto(${photo.id})">🗑️</button>
      </div>
    </div>
  `).join('');
}

function togglePhotoSelection(id) {
  if (selectedPhotos.has(id)) {
    selectedPhotos.delete(id);
  } else {
    selectedPhotos.add(id);
  }
  updateBatchUI();
}

function updateBatchUI() {
  const count = selectedPhotos.size;
  const batchActions = document.getElementById('batchActions');
  const batchDeleteBtn = document.getElementById('batchDeleteBtn');

  if (count > 0) {
    batchActions.classList.remove('hidden');
    batchDeleteBtn.disabled = false;
    document.getElementById('selectedCount').textContent = `已選擇 ${count} 張`;
  } else {
    batchActions.classList.add('hidden');
    batchDeleteBtn.disabled = true;
  }
}

function selectAllPhotos() {
  if (selectedPhotos.size === currentPhotos.length) {
    selectedPhotos.clear();
  } else {
    currentPhotos.forEach(p => selectedPhotos.add(p.id));
  }
  renderPhotos();
  updateBatchUI();
}

function clearSelection() {
  selectedPhotos.clear();
  renderPhotos();
  updateBatchUI();
}

async function batchDeletePhotos() {
  if (selectedPhotos.size === 0) return;
  showConfirm(`確定要刪除選中的 ${selectedPhotos.size} 張照片嗎？`, async () => {
    try {
      await api.post('/api/admin/photos/batch-delete', { ids: [...selectedPhotos] });
      showToast('已刪除 ' + selectedPhotos.size + ' 張照片', 'success');
      selectedPhotos.clear();
      await loadAlbumPhotos(currentAlbumId);
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

function editPhoto(id, description) {
  document.getElementById('photoId').value = id;
  document.getElementById('photoDescription').value = description;
  openModal('photoModal');
}

async function savePhoto(e) {
  e.preventDefault();
  const id = document.getElementById('photoId').value;
  const description = document.getElementById('photoDescription').value;

  try {
    await api.put(`/api/admin/photos/${id}`, { description });
    closeModal('photoModal');
    showToast('已更新', 'success');
    await loadAlbumPhotos(currentAlbumId);
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function deletePhoto(id) {
  showConfirm('確定要刪除這張照片嗎？', async () => {
    try {
      await api.post('/api/admin/photos/batch-delete', { ids: [id] });
      showToast('已刪除', 'success');
      await loadAlbumPhotos(currentAlbumId);
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

// ===== File Upload =====
function setupUpload() {
  const zone = document.getElementById('uploadZone');
  const input = document.getElementById('photoInput');

  zone.addEventListener('click', () => input.click());

  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));

  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    input.files = e.dataTransfer.files;
    handleFiles(input.files);
  });

  input.addEventListener('change', () => handleFiles(input.files));
}

let pendingFiles = [];

async function handleFiles(files) {
  const preview = document.getElementById('uploadPreview');
  pendingFiles = Array.from(files);

  preview.innerHTML = pendingFiles.map((f, i) => `
    <div style="position:relative;">
      <img id="preview-${i}" src="">
    </div>
  `).join('');

  pendingFiles.forEach((f, i) => {
    const reader = new FileReader();
    reader.onload = e => document.getElementById(`preview-${i}`).src = e.target.result;
    reader.readAsDataURL(f);
  });

  // Auto upload after selection
  await uploadPhotos();
}

async function uploadPhotos() {
  if (pendingFiles.length === 0) return;

  const formData = new FormData();
  pendingFiles.forEach(f => formData.append('photos', f));

  try {
    const result = await api.upload(`/api/admin/albums/${currentAlbumId}/photos`, formData);
    showToast(`已上傳 ${result.photos.length} 張照片`, 'success');
    pendingFiles = [];
    document.getElementById('uploadPreview').innerHTML = '';
    document.getElementById('photoInput').value = '';
    await loadAlbumPhotos(currentAlbumId);
  } catch (e) {
    showToast('上傳失敗: ' + e.message, 'error');
  }
}

// ===== Categories Management =====
async function loadCategories() {
  categories = await api.get('/api/admin/categories');
  renderCategories();
}

function renderCategories() {
  const tbody = document.getElementById('categoriesTable');
  tbody.innerHTML = categories.map(c => `
    <tr>
      <td>${c.sort_order}</td>
      <td>
        ${c.name}
        ${c.is_admin_only ? '<span class="badge badge-danger">🔒 管理員專用</span>' : ''}
      </td>
      <td>${c.album_count}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="editCategory(${c.id})">編輯</button>
        <button class="btn btn-danger btn-sm" onclick="deleteCategory(${c.id}, '${c.name.replace(/'/g, "\\'")}')">刪除</button>
      </td>
    </tr>
  `).join('');
}

function openCategoryModal(cat = null) {
  document.getElementById('categoryModalTitle').textContent = cat ? '編輯分類' : '新增分類';
  document.getElementById('categoryId').value = cat?.id || '';
  document.getElementById('categoryName').value = cat?.name || '';
  document.getElementById('categoryAdminOnly').checked = cat?.is_admin_only === 1 || cat?.is_admin_only === true;
  openModal('categoryModal');
}

function editCategory(id) {
  const cat = categories.find(c => c.id === id);
  if (cat) openCategoryModal(cat);
}

async function saveCategory(e) {
  e.preventDefault();
  const id = document.getElementById('categoryId').value;
  const name = document.getElementById('categoryName').value;
  const isAdminOnly = document.getElementById('categoryAdminOnly').checked;

  try {
    if (id) {
      await api.put(`/api/admin/categories/${id}`, { name, isAdminOnly });
    } else {
      await api.post('/api/admin/categories', { name, isAdminOnly });
    }
    closeModal('categoryModal');
    showToast(id ? '分類已更新' : '分類已新增', 'success');
    loadCategories();
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function deleteCategory(id, name) {
  showConfirm(`確定要刪除分類「${name}」嗎？`, async () => {
    try {
      await api.del(`/api/admin/categories/${id}`);
      showToast('分類已刪除', 'success');
      loadCategories();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

// ===== Modal Helpers =====
function openModal(id) {
  document.getElementById(id).classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
  document.body.style.overflow = '';
}

function showConfirm(message, onConfirm) {
  document.getElementById('confirmMessage').textContent = message;
  document.getElementById('confirmBtn').onclick = () => {
    closeModal('confirmModal');
    onConfirm();
  };
  openModal('confirmModal');
}

// ===== Toast =====
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ===== Init =====
document.getElementById('logoutBtn').addEventListener('click', handleLogout);
document.getElementById('userForm').addEventListener('submit', saveUser);
document.getElementById('albumForm').addEventListener('submit', saveAlbum);
document.getElementById('photoForm').addEventListener('submit', savePhoto);
document.getElementById('categoryForm').addEventListener('submit', saveCategory);

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// Redirect guard
let redirectCount = 0;

async function checkAuth() {
  try {
    currentUser = await api.get('/api/auth/me');
    if (!currentUser || currentUser.role !== 'admin') {
      if (redirectCount < 3) {
        redirectCount++;
        redirectToLogin();
      }
      return;
    }
    document.getElementById('userDisplay').textContent = currentUser.displayName || currentUser.username;
  } catch (e) {
    console.error('Auth check failed:', e);
    if (redirectCount < 3) {
      redirectCount++;
      redirectToLogin();
    }
  }
}

// Init
(async () => {
  await checkAuth();
  await loadUsers();
  await loadAlbums();
  await loadCategories();
  setupUpload();
})();

// Banner Upload
async function uploadBanner() {
  const fileInput = document.getElementById('bannerFile');
  const file = fileInput.files[0];
  if (!file) return alert('請選擇圖片');
  
  const formData = new FormData();
  formData.append('image', file);
  
  try {
    // Upload to Catbox via server
    const res = await fetch('/api/admin/banner', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    
    if (data.success) {
      const bannerUrl = data.url;
      
      // Show preview
      document.getElementById('bannerPreview').innerHTML = `<img src="${bannerUrl}" style="max-width: 100%; border-radius: 8px;"> `;
      
      showToast('橫幅上傳成功！', 'success');
    } else {
      throw new Error(data.error || '上傳失敗');
    }
  } catch (e) {
    showToast('上傳失敗：' + e.message, 'error');
  }
}
