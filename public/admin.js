// ===== 管理后台逻辑 =====
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

let works = [];
let existingCategories = [];
let existingSubcategories = [];
let selectedFiles = [];

const $form = $('#uploadForm');
const $fileInput = $('#fileInput');
const $dropzone = $('#dropzone');
const $previewList = $('#previewList');
const $progress = $('#uploadProgress');
const $progressFill = $progress.querySelector('.progress-fill');
const $msg = $('#uploadMsg');
const $body = $('#workBody');
const $empty = $('#emptyAdmin');
const $selectAll = $('#selectAll');
const $batchBtn = $('#batchDelete');
const $search = $('#searchInput');
const $filterCat = $('#filterCat');
const $stats = { total: $('#totalCount'), cat: $('#catCount'), size: $('#sizeCount') };

// ===== 登录/认证 =====
const $loginOverlay = $('#loginOverlay');
const $loginForm = $('#loginForm');
const $loginError = $('#loginError');
const $loginPassword = $('#adminPassword');

// 添加登出按钮
function addLogoutBtn() {
  const nav = document.querySelector('.admin-nav nav');
  if (nav && !nav.querySelector('#logoutBtn')) {
    const logoutBtn = document.createElement('button');
    logoutBtn.id = 'logoutBtn';
    logoutBtn.textContent = '退出登录';
    logoutBtn.className = 'btn-logout';
    logoutBtn.onclick = logout;
    nav.appendChild(logoutBtn);
  }
}

function showLogin() {
  $loginOverlay.hidden = false;
  $loginPassword.focus();
}

function hideLogin() {
  $loginOverlay.hidden = true;
}

async function checkAuth() {
  try {
    const res = await fetch('/api/admin/check', { credentials: 'same-origin' });
    const data = await res.json();
    if (data.authenticated) {
      hideLogin();
      return true;
    }
  } catch (e) { /* 忽略 */ }
  showLogin();
  return false;
}

async function handleLogin(e) {
  e.preventDefault();
  const password = $loginPassword.value;
  $loginError.hidden = true;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (data.success) {
      hideLogin();
      $loginForm.reset();
      addLogoutBtn();
      await loadData();
    } else {
      $loginError.textContent = data.message || '密码错误，请重试';
      $loginError.hidden = false;
      $loginPassword.select();
    }
  } catch (e) {
    $loginError.textContent = '登录失败，请重试';
    $loginError.hidden = false;
  }
}

async function logout() {
  try {
    await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (e) { /* 忽略 */ }
  showLogin();
  works = [];
  renderStats();
  renderWorks();
}

// ===== 初始化 =====
async function init() {
  $loginForm.addEventListener('submit', handleLogin);
  const authed = await checkAuth();
  if (authed) {
    addLogoutBtn();
    await loadData();
  }
  bindEvents();
}

async function loadData() {
  try {
    const res = await fetch('/api/works', { credentials: 'same-origin' });
    works = await res.json();
    existingCategories = [...new Set(works.map(w => w.category || '未分类'))];
    existingSubcategories = [...new Set(works.map(w => w.subcategory).filter(Boolean))];
    renderStats();
    renderCategoryOptions();
    renderWorks();
  } catch (e) {
    showMsg('加载数据失败', 'error');
  }
}

function renderStats() {
  $stats.total.textContent = works.length;
  $stats.cat.textContent = new Set(works.map(w => w.subcategory || w.category || '未分类')).size;
  const totalSize = works.reduce((s, w) => s + (w.size || 0), 0);
  $stats.size.textContent = (totalSize / 1024 / 1024).toFixed(2) + ' MB';
}

function renderCategoryOptions() {
  const datalist = $('#catList');
  datalist.innerHTML = existingCategories.map(c => `<option value="${c}">`).join('');
  const subcatList = $('#subcatList');
  if (subcatList) {
    subcatList.innerHTML = existingSubcategories.map(c => `<option value="${c}">`).join('');
  }
  $filterCat.innerHTML = '<option value="all">全部分类</option>' +
    existingSubcategories.map(c => `<option value="${c}">${c}</option>`).join('');
}

// ===== 事件绑定 =====
function bindEvents() {
  // 拖拽上传
  $dropzone.addEventListener('click', () => $fileInput.click());
  $dropzone.addEventListener('dragover', (e) => {
    e.preventDefault(); $dropzone.classList.add('dragging');
  });
  $dropzone.addEventListener('dragleave', () => $dropzone.classList.remove('dragging'));
  $dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); $dropzone.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });
  $fileInput.addEventListener('change', (e) => addFiles(e.target.files));

  // 表单提交
  $form.addEventListener('submit', handleUpload);
  $form.addEventListener('reset', () => {
    selectedFiles = [];
    renderPreviews();
    hideMsg();
  });

  // 表格操作
  $selectAll.addEventListener('change', (e) => {
    $$('.row-check').forEach(cb => cb.checked = e.target.checked);
    updateBatchBtn();
  });
  $body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    if (e.target.classList.contains('edit-btn')) openEdit(id);
    if (e.target.classList.contains('del-btn')) deleteWork(id);
    if (e.target.classList.contains('row-check')) updateBatchBtn();
  });
  $batchBtn.addEventListener('click', batchDelete);

  // 搜索与分类过滤
  $search.addEventListener('input', renderWorks);
  $filterCat.addEventListener('change', renderWorks);

  // 编辑弹窗
  $('.modal-close').addEventListener('click', closeEdit);
  $('#editCancel').addEventListener('click', closeEdit);
  $('#editForm').addEventListener('submit', saveEdit);
}

// ===== 文件预览 =====
function addFiles(fileList) {
  const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
  if (files.length === 0) return;
  selectedFiles.push(...files);
  renderPreviews();
}

function removeFile(idx) {
  selectedFiles.splice(idx, 1);
  renderPreviews();
}

function renderPreviews() {
  $previewList.innerHTML = selectedFiles.map((f, i) => `
    <div class="preview-item">
      <img src="${URL.createObjectURL(f)}" alt="${f.name}" />
      <button type="button" class="rm" data-idx="${i}" title="移除">×</button>
    </div>
  `).join('');
  $$('.rm', $previewList).forEach(btn => {
    btn.addEventListener('click', () => removeFile(parseInt(btn.dataset.idx, 10)));
  });
}

// ===== 上传 =====
async function handleUpload(e) {
  e.preventDefault();
  if (selectedFiles.length === 0) {
    showMsg('请先选择图片', 'error'); return;
  }
  const formData = new FormData($form);
  $progress.hidden = false;
  $progressFill.style.width = '0%';
  hideMsg();

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/works');
  xhr.withCredentials = true;

  xhr.upload.addEventListener('progress', (ev) => {
    if (ev.lengthComputable) {
      const pct = (ev.loaded / ev.total) * 100;
      $progressFill.style.width = pct + '%';
    }
  });
  xhr.onload = () => {
    $progress.hidden = true;
    if (xhr.status >= 200 && xhr.status < 300) {
      showMsg(`成功上传 ${selectedFiles.length} 张作品`, 'success');
      selectedFiles = [];
      $form.reset();
      renderPreviews();
      loadData();
    } else {
      try {
        const r = JSON.parse(xhr.responseText);
        showMsg('上传失败：' + (r.message || xhr.status), 'error');
      } catch { showMsg('上传失败', 'error'); }
    }
  };
  xhr.onerror = () => { $progress.hidden = true; showMsg('网络错误', 'error'); };
  xhr.send(formData);
}

// ===== 渲染作品表格 =====
function renderWorks() {
  const q = $search.value.trim().toLowerCase();
  const cat = $filterCat.value;
  const list = works.filter(w => {
    if (cat !== 'all' && (w.subcategory || w.category || '未分类') !== cat) return false;
    if (!q) return true;
    const hay = `${w.title} ${w.category} ${w.subcategory || ''} ${(w.tags || []).join(' ')}`.toLowerCase();
    return hay.includes(q);
  });

  if (list.length === 0) {
    $body.innerHTML = '';
    $empty.hidden = false;
  } else {
    $empty.hidden = true;
    $body.innerHTML = list.map(w => `
      <tr data-id="${w.id}">
        <td><input type="checkbox" class="row-check" /></td>
        <td><img src="${w.url}" class="thumb" alt="" onerror="this.style.background='#555';this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22><rect width=%2240%22 height=%2240%22 fill=%22%22333%22/></svg>'" /></td>
        <td><a href="${w.url}" target="_blank">${escape(w.title)}</a></td>
        <td>${escape(w.subcategory || w.category || '未分类')}</td>
        <td>${escape(w.category || '')}</td>
        <td>${(w.tags || []).map(t => `<span class="tag-chip">${escape(t)}</span>`).join('') || '—'}</td>
        <td>${formatSize(w.size)}</td>
        <td>${formatTime(w.createdAt)}</td>
        <td>
          <div class="action-btns">
            <button class="edit-btn">编辑</button>
            <button class="del-btn">删除</button>
          </div>
        </td>
      </tr>
    `).join('');
  }
  $selectAll.checked = false;
  updateBatchBtn();
}

function updateBatchBtn() {
  const checked = $$('.row-check').filter(cb => cb.checked).length;
  $batchBtn.disabled = checked === 0;
  $batchBtn.textContent = checked > 0 ? `批量删除 (${checked})` : '批量删除';
}

// ===== 操作 =====
async function deleteWork(id) {
  if (!confirm('确认删除此作品？此操作不可恢复。')) return;
  try {
    const res = await fetch(`/api/works/${id}`, { method: 'DELETE', credentials: 'same-origin' });
    if (res.ok) { showMsg('已删除', 'success'); loadData(); }
    else { showMsg('删除失败', 'error'); }
  } catch (e) { showMsg('删除失败', 'error'); }
}

async function batchDelete() {
  const ids = $$('.row-check').filter(cb => cb.checked).map(cb => cb.closest('tr').dataset.id);
  if (ids.length === 0) return;
  if (!confirm(`确认删除选中的 ${ids.length} 个作品？`)) return;
  try {
    const res = await fetch('/api/works/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ ids })
    });
    if (res.ok) { showMsg(`已删除 ${ids.length} 个作品`, 'success'); loadData(); }
    else showMsg('删除失败', 'error');
  } catch (e) { showMsg('删除失败', 'error'); }
}

// ===== 编辑 =====
function openEdit(id) {
  const w = works.find(x => x.id === id);
  if (!w) return;
  const f = $('#editForm');
  f.id.value = w.id;
  f.title.value = w.title || '';
  f.category.value = w.category || '';
  f.subcategory.value = w.subcategory || '';
  f.tags.value = (w.tags || []).join(', ');
  f.description.value = w.description || '';
  $('#editModal').hidden = false;
}

function closeEdit() { $('#editModal').hidden = true; }

async function saveEdit(e) {
  e.preventDefault();
  const f = $('#editForm');
  const id = f.id.value;
  const payload = {
    title: f.title.value,
    category: f.category.value,
    subcategory: f.subcategory.value,
    tags: f.tags.value.split(',').map(t => t.trim()).filter(Boolean),
    description: f.description.value
  };
  try {
    const res = await fetch(`/api/works/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
    if (res.ok) { showMsg('已保存', 'success'); closeEdit(); loadData(); }
    else showMsg('保存失败', 'error');
  } catch (e) { showMsg('保存失败', 'error'); }
}

// ===== 工具 =====
function showMsg(text, type = 'success') {
  $msg.textContent = text;
  $msg.className = 'msg ' + type;
}
function hideMsg() { $msg.textContent = ''; $msg.className = 'msg'; }
function escape(str) {
  const div = document.createElement('div');
  div.textContent = String(str || '');
  return div.innerHTML;
}
function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}
function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

init();