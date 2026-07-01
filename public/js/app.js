// ===== State =====
let currentUser = null;
let categories = [];
let albums = [];
let currentAlbum = null;
let currentPhotos = [];
let currentCategoryId = null;
let searchQuery = '';
let currentPage = 1;
let lightboxIndex = 0;

// ===== API Helpers =====
const api = {
  async get(endpoint) {
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(await res.text());
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
  }
};

// ===== Auth =====
async function checkAuth() {
  try {
    currentUser = await api.get('/api/auth/me');
    updateAuthUI();
  } catch (e) {
    console.error('Auth check failed:', e);
  }
}

function updateAuthUI() {
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const userDisplay = document.getElementById('userDisplay');
  const adminLink = document.getElementById('adminLink');
  const albumActions = document.getElementById('albumActions');

  if (currentUser) {
    loginBtn.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
    userDisplay.classList.remove('hidden');
    userDisplay.textContent = currentUser.displayName || currentUser.username;
    userDisplay.style.cursor = 'pointer';
    userDisplay.onclick = () => openModal('profileModal');

    if (currentUser.role === 'admin') {
      adminLink.classList.remove('hidden');
    }
    if (currentAlbum) {
      albumActions.classList.remove('hidden');
    }
  } else {
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    userDisplay.classList.add('hidden');
    adminLink.classList.add('hidden');
    albumActions.classList.add('hidden');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const form = e.target;
  try {
    currentUser = await api.post('/api/auth/login', {
      username: form.username.value,
      password: form.password.value
    });
    closeModal('loginModal');
    form.reset();
    updateAuthUI();
    showToast('登入成功', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function handleLogout() {
  await api.post('/api/auth/logout');
  currentUser = null;
  updateAuthUI();
  showToast('已登出', 'success');
}

async function handleProfileUpdate(e) {
  e.preventDefault();
  const form = e.target;
  try {
    await api.put('/api/auth/profile', {
      displayName: form.displayName.value,
      email: form.email.value
    });
    currentUser.displayName = form.displayName.value;
    currentUser.email = form.email.value;
    updateAuthUI();
    closeModal('profileModal');
    showToast('已更新', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

async function handlePasswordChange(e) {
  e.preventDefault();
  const form = e.target;
  try {
    await api.post('/api/auth/change-password', {
      oldPassword: form.oldPassword.value,
      newPassword: form.newPassword.value
    });
    form.reset();
    showToast('密碼已變更', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

// ===== Categories =====
async function loadCategories() {
  try {
    categories = await api.get('/api/categories');
    renderCategories();
  } catch (e) {
    showToast('載入分類失敗', 'error');
  }
}

function renderCategories() {
  const container = document.getElementById('categories');
  container.innerHTML = `
    <a href="#" class="category-chip ${!currentCategoryId ? 'active' : ''}" onclick="filterByCategory(null); return false;">
      全部
    </a>
    ${categories.map(c => `
      <a href="#" class="category-chip ${currentCategoryId == c.id ? 'active' : ''}" onclick="filterByCategory(${c.id}); return false;">
        ${c.name} <span class="count">(${c.album_count})</span>
      </a>
    `).join('')}
  `;
}

function filterByCategory(id) {
  currentCategoryId = id;
  currentPage = 1;
  renderCategories();
  loadAlbums();
}

// ===== Albums =====
async function loadAlbums(page = 1) {
  currentPage = page;
  const container = document.getElementById('albumsGrid');
  container.innerHTML = '<span class="loading"></span>';

  try {
    let url = `/api/albums?page=${page}&limit=12`;
    if (currentCategoryId) url += `&category_id=${currentCategoryId}`;
    if (searchQuery) url += `&search=${encodeURIComponent(searchQuery)}`;

    const data = await api.get(url);
    albums = data.albums;
    renderAlbums(data);
  } catch (e) {
    container.innerHTML = `<p class="text-light">載入失敗: ${e.message}</p>`;
  }
}

function renderAlbums(data) {
  const container = document.getElementById('albumsGrid');
  const pagination = document.getElementById('pagination');

  if (data.albums.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
        <h3>沒有相簿</h3>
        <p>目前沒有符合條件的相簿</p>
      </div>
    `;
    pagination.innerHTML = '';
    return;
  }

  container.innerHTML = data.albums.map(album => `
    <a href="#" class="album-card" onclick="viewAlbum(${album.id}); return false;">
      <div class="album-cover">
        ${album.cover_filename
          ? `<img src="/thumbnails/${album.cover_filename}" alt="${album.title}">`
          : '<span class="placeholder">📷</span>'
        }
      </div>
      <div class="album-info">
        <div class="album-title">${album.title}</div>
        <div class="album-meta">
          <span>📁 ${album.category_name || '未分類'}</span>
          <span>📷 ${album.photo_count || 0} 張</span>
        </div>
      </div>
    </a>
  `).join('');

  // Pagination
  if (data.totalPages > 1) {
    pagination.innerHTML = `
      <button ${data.page <= 1 ? 'disabled' : ''} onclick="loadAlbums(${data.page - 1})">上一頁</button>
      ${Array.from({ length: Math.min(5, data.totalPages) }, (_, i) => {
        const p = data.page <= 3 ? i + 1 : data.page - 2 + i;
        if (p > data.totalPages) return '';
        return `<button class="${p === data.page ? 'active' : ''}" onclick="loadAlbums(${p})">${p}</button>`;
      }).join('')}
      <button ${data.page >= data.totalPages ? 'disabled' : ''} onclick="loadAlbums(${data.page + 1})">下一頁</button>
    `;
  } else {
    pagination.innerHTML = '';
  }
}

function searchAlbums() {
  searchQuery = document.getElementById('searchInput').value;
  currentPage = 1;
  loadAlbums();
}

// ===== Album Detail =====
async function viewAlbum(id) {
  try {
    const album = await api.get(`/api/albums/${id}`);
    currentAlbum = album;
    currentPhotos = album.photos;

    document.getElementById('homePage').classList.add('hidden');
    document.getElementById('albumPage').classList.remove('hidden');

    document.getElementById('albumTitle').textContent = album.title;
    document.getElementById('albumCategory').textContent = `📁 ${album.category_name || '未分類'}`;
    document.getElementById('albumDate').textContent = `📅 ${new Date(album.created_at).toLocaleDateString('zh-TW')}`;
    document.getElementById('albumCount').textContent = `📷 ${album.photos.length} 張照片`;

    renderPhotos();
    updateAuthUI();
  } catch (e) {
    showToast('載入相簿失敗', 'error');
  }
}

function renderPhotos() {
  const container = document.getElementById('photosGrid');

  if (currentPhotos.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>沒有照片</h3>
        <p>這個相簿還沒有上傳任何照片</p>
      </div>
    `;
    return;
  }

  container.innerHTML = currentPhotos.map((photo, i) => `
    <div class="photo-card" onclick="openLightbox(${i})">
      <img src="/thumbnails/${photo.filename}" alt="${photo.description || ''}">
      ${photo.description ? `<div class="caption">${photo.description}</div>` : ''}
    </div>
  `).join('');
}

function downloadAlbum() {
  if (!currentUser) {
    showToast('請先登入', 'error');
    openModal('loginModal');
    return;
  }
  window.location.href = `/api/albums/${currentAlbum.id}/download`;
}

// ===== Lightbox =====
function openLightbox(index) {
  lightboxIndex = index;
  updateLightbox();
  document.getElementById('lightbox').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('active');
  document.body.style.overflow = '';
}

function updateLightbox() {
  const photo = currentPhotos[lightboxIndex];
  document.getElementById('lightboxImg').src = `/thumbnails/${photo.filename}`;
  document.getElementById('lightboxCaption').textContent = photo.description || '';
  document.getElementById('lightboxCounter').textContent = `${lightboxIndex + 1} / ${currentPhotos.length}`;
}

function lightboxPrev() {
  lightboxIndex = (lightboxIndex - 1 + currentPhotos.length) % currentPhotos.length;
  updateLightbox();
}

function lightboxNext() {
  lightboxIndex = (lightboxIndex + 1) % currentPhotos.length;
  updateLightbox();
}

// ===== Modal =====
function openModal(id) {
  document.getElementById(id).classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
  document.body.style.overflow = '';
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

// ===== Keyboard Navigation =====
document.addEventListener('keydown', e => {
  if (!document.getElementById('lightbox').classList.contains('active')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') lightboxPrev();
  if (e.key === 'ArrowRight') lightboxNext();
});

// ===== Click outside modal to close =====
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// ===== Init =====
document.getElementById('loginForm').addEventListener('submit', handleLogin);
document.getElementById('logoutBtn').addEventListener('click', handleLogout);
document.getElementById('profileForm').addEventListener('submit', handleProfileUpdate);
document.getElementById('passwordForm').addEventListener('submit', handlePasswordChange);
document.getElementById('loginBtn').addEventListener('click', () => openModal('loginModal'));

document.getElementById('searchInput').addEventListener('keypress', e => {
  if (e.key === 'Enter') searchAlbums();
});

// Back to home on logo click (handled by router-like pattern)
document.querySelector('.logo').addEventListener('click', e => {
  e.preventDefault();
  document.getElementById('homePage').classList.remove('hidden');
  document.getElementById('albumPage').classList.add('hidden');
  currentAlbum = null;
  currentPhotos = [];
});

// Init
(async () => {
  await checkAuth();
  await loadCategories();
  await loadAlbums();
})();
