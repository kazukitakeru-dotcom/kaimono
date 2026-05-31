// ══════════════════════════════════════════════
//  買い物メモ — app.js
// ══════════════════════════════════════════════

'use strict';

// ── PWA Service Worker ──
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ── DB ──
const DB_NAME = 'kaimono-db';
const DB_VERSION = 1;
const STORES = {
  products: 'products',
  categories: 'categories',
  storeNames: 'storeNames',
  templates: 'templates',
  prices: 'prices',
  shoppingList: 'shoppingList',
};

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORES.products))
        d.createObjectStore(STORES.products, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(STORES.categories))
        d.createObjectStore(STORES.categories, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(STORES.storeNames))
        d.createObjectStore(STORES.storeNames, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(STORES.templates))
        d.createObjectStore(STORES.templates, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(STORES.prices))
        d.createObjectStore(STORES.prices, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(STORES.shoppingList))
        d.createObjectStore(STORES.shoppingList, { keyPath: 'id' });
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function dbAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(storeName, obj) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(obj);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function dbClear(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ── State ──
let products = [];
let categories = [];
let storeNames = [];
let templates = [];
let prices = [];
let shoppingList = [];

let currentTab = 'products';
let currentCategoryFilter = 'all';
let searchQuery = '';
let sortMode = false;
let editingProductId = null;
let editingTemplateId = null;
let editingPriceProductId = null;
let pendingImageDataUrl = null;
let confirmCallback = null;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Load all data ──
async function loadAll() {
  [products, categories, storeNames, templates, prices, shoppingList] = await Promise.all([
    dbAll(STORES.products),
    dbAll(STORES.categories),
    dbAll(STORES.storeNames),
    dbAll(STORES.templates),
    dbAll(STORES.prices),
    dbAll(STORES.shoppingList),
  ]);
  // Sort by order field
  products.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// ── Toast ──
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ── Confirm dialog ──
function showConfirm(title, msg, okLabel = '削除する') {
  return new Promise((resolve) => {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent = msg;
    document.getElementById('confirmOkBtn').textContent = okLabel;
    const overlay = document.getElementById('confirmOverlay');
    overlay.classList.add('open');
    confirmCallback = (ok) => {
      overlay.classList.remove('open');
      resolve(ok);
    };
  });
}

document.getElementById('confirmOkBtn').addEventListener('click', () => confirmCallback && confirmCallback(true));
document.getElementById('confirmCancelBtn').addEventListener('click', () => confirmCallback && confirmCallback(false));

// ── Modal helpers ──
function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('open');
  });
});

// ── Tab switching ──
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    currentTab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    document.getElementById('page-' + tab).classList.add('active');

    // FAB visibility
    const fab = document.getElementById('fabBtn');
    const sortBtn = document.getElementById('sortBtn');
    if (tab === 'products' || tab === 'templates') {
      fab.classList.remove('hidden');
    } else {
      fab.classList.add('hidden');
    }
    if (tab === 'products') {
      sortBtn.classList.remove('hidden');
    } else {
      sortBtn.classList.add('hidden');
      if (sortMode) exitSortMode();
    }

    render();
  });
});

// ── FAB ──
document.getElementById('fabBtn').addEventListener('click', () => {
  if (currentTab === 'products') openProductModal(null);
  if (currentTab === 'templates') openTemplateModal(null);
});

// ── Search ──
const searchBtn = document.getElementById('searchBtn');
const searchBar = document.getElementById('searchBar');
const searchInput = document.getElementById('searchInput');

searchBtn.addEventListener('click', () => {
  searchBar.classList.toggle('hidden');
  if (!searchBar.classList.contains('hidden')) {
    searchInput.focus();
  } else {
    searchQuery = '';
    searchInput.value = '';
    renderProducts();
  }
});

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim();
  renderProducts();
});

// ── Sort mode ──
const sortBtn = document.getElementById('sortBtn');
const sortModeBar = document.getElementById('sortModeBar');
const sortDoneBtn = document.getElementById('sortDoneBtn');

sortBtn.addEventListener('click', () => {
  sortMode = !sortMode;
  if (sortMode) {
    sortModeBar.classList.add('visible');
    document.getElementById('productList').classList.add('sort-mode');
  } else {
    exitSortMode();
  }
});

sortDoneBtn.addEventListener('click', exitSortMode);

function exitSortMode() {
  sortMode = false;
  sortModeBar.classList.remove('visible');
  document.getElementById('productList').classList.remove('sort-mode');
}

// ── RENDER: Products ──
function renderProducts() {
  const list = document.getElementById('productList');
  const empty = document.getElementById('productEmpty');

  let filtered = products.filter((p) => {
    const matchCat = currentCategoryFilter === 'all' || p.categoryId === currentCategoryFilter;
    const matchQ = !searchQuery || p.name.includes(searchQuery) || (p.memo || '').includes(searchQuery);
    return matchCat && matchQ;
  });

  if (filtered.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = filtered.map((p) => {
    const cat = categories.find((c) => c.id === p.categoryId);
    const cheapest = getCheapestPrice(p.id);
    const inList = shoppingList.some((s) => s.productId === p.id && !s.done);

    return `<div class="product-card animate-in" data-id="${p.id}" draggable="${sortMode}">
      <div class="drag-handle" title="ドラッグして並び替え">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      </div>
      <div class="product-thumb">
        ${p.imageDataUrl ? `<img src="${p.imageDataUrl}" alt="${escHtml(p.name)}">` : iconImage()}
      </div>
      <div class="product-info">
        <div class="product-name">${escHtml(p.name)}</div>
        <div class="product-meta">
          ${cat ? `<span class="product-category">${escHtml(cat.name)}</span>` : ''}
          ${p.memo ? `<span class="product-memo">${escHtml(p.memo)}</span>` : ''}
        </div>
        ${cheapest ? `<div class="product-cheapest">最安値 ${escHtml(cheapest.storeName)} ${cheapest.price.toLocaleString()}円</div>` : ''}
      </div>
      <div class="product-actions">
        <button class="add-to-list-btn ${inList ? 'in-list' : ''}" data-id="${p.id}" title="${inList ? 'リストに追加済み' : 'リストに追加'}">
          ${inList
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
          }
        </button>
      </div>
    </div>`;
  }).join('');

  // Card click → edit
  list.querySelectorAll('.product-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.add-to-list-btn') || e.target.closest('.drag-handle')) return;
      if (sortMode) return;
      openProductModal(card.dataset.id);
    });
  });

  // Add to list btn
  list.querySelectorAll('.add-to-list-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleShoppingList(btn.dataset.id);
    });
  });

  // Drag-and-drop sort
  initDragSort(list, '.product-card', (orderedIds) => {
    orderedIds.forEach((id, i) => {
      const p = products.find((x) => x.id === id);
      if (p) { p.order = i; dbPut(STORES.products, p); }
    });
    products.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  });
}

function renderCategoryFilter() {
  const row = document.getElementById('categoryFilter');
  row.innerHTML = `<button class="filter-pill ${currentCategoryFilter === 'all' ? 'active' : ''}" data-cat="all">すべて</button>` +
    categories.map((c) => `<button class="filter-pill ${currentCategoryFilter === c.id ? 'active' : ''}" data-cat="${c.id}">${escHtml(c.name)}</button>`).join('');
  row.querySelectorAll('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      currentCategoryFilter = pill.dataset.cat;
      renderCategoryFilter();
      renderProducts();
    });
  });
}

function getCheapestPrice(productId) {
  const pList = prices.filter((p) => p.productId === productId);
  if (!pList.length) return null;
  const min = pList.reduce((a, b) => a.price <= b.price ? a : b);
  const store = storeNames.find((s) => s.id === min.storeId);
  return { price: min.price, storeName: store ? store.name : '不明' };
}

// ── RENDER: Shopping List ──
function renderShoppingList() {
  const container = document.getElementById('shoppingList');
  const empty = document.getElementById('shoppingEmpty');

  const pending = shoppingList.filter((s) => !s.done);
  const done = shoppingList.filter((s) => s.done);

  if (!pending.length && !done.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  let html = '';

  const renderItem = (s) => {
    const p = products.find((x) => x.id === s.productId);
    const name = p ? p.name : s.name || '不明な商品';
    const img = p && p.imageDataUrl ? `<img src="${p.imageDataUrl}" alt="${escHtml(name)}">` : iconImage(20);
    const cheapest = p ? getCheapestPrice(p.id) : null;
    return `<div class="shopping-item ${s.done ? 'done' : ''} animate-in" data-sid="${s.id}">
      <div class="shopping-check" data-sid="${s.id}">
        ${s.done ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
      </div>
      <div class="shopping-thumb">${img}</div>
      <div class="shopping-info">
        <div class="shopping-name">${escHtml(name)}</div>
        ${cheapest ? `<div class="shopping-store">最安値: ${escHtml(cheapest.storeName)} ${cheapest.price.toLocaleString()}円</div>` : ''}
      </div>
      <button class="shopping-remove-btn" data-sid="${s.id}" title="リストから削除">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  };

  html += pending.map(renderItem).join('');
  if (done.length) {
    html += `<div class="list-done-header">購入済み (${done.length})</div>`;
    html += done.map(renderItem).join('');
  }

  container.innerHTML = html;

  container.querySelectorAll('.shopping-check').forEach((el) => {
    el.addEventListener('click', async () => {
      const s = shoppingList.find((x) => x.id === el.dataset.sid);
      if (s) {
        s.done = !s.done;
        await dbPut(STORES.shoppingList, s);
        renderShoppingList();
      }
    });
  });

  container.querySelectorAll('.shopping-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const sid = btn.dataset.sid;
      shoppingList = shoppingList.filter((s) => s.id !== sid);
      await dbDelete(STORES.shoppingList, sid);
      renderShoppingList();
      renderProducts();
    });
  });
}

async function toggleShoppingList(productId) {
  const existing = shoppingList.find((s) => s.productId === productId && !s.done);
  if (existing) {
    shoppingList = shoppingList.filter((s) => s.id !== existing.id);
    await dbDelete(STORES.shoppingList, existing.id);
    showToast('リストから削除しました');
  } else {
    const item = { id: uid(), productId, done: false, addedAt: Date.now() };
    shoppingList.push(item);
    await dbPut(STORES.shoppingList, item);
    showToast('リストに追加しました');
  }
  renderProducts();
  renderShoppingList();
}

// ── RENDER: Templates ──
function renderTemplates() {
  const list = document.getElementById('templateList');
  const empty = document.getElementById('templateEmpty');

  if (!templates.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = templates.map((t) => {
    const items = (t.productIds || []).map((pid) => products.find((p) => p.id === pid)).filter(Boolean);
    return `<div class="template-card animate-in">
      <div class="template-header" data-tid="${t.id}">
        <div class="template-name-wrap">
          <div class="template-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          </div>
          <div>
            <div class="template-name">${escHtml(t.name)}</div>
            <div class="template-count">${items.length}商品</div>
          </div>
        </div>
        <div class="template-actions">
          <button class="template-add-btn" data-tid="${t.id}">追加</button>
          <button class="header-icon-btn" data-edit-tid="${t.id}" title="編集">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </div>
      <div class="template-items">
        ${items.map((p) => `<div class="template-item-row">${escHtml(p.name)}</div>`).join('')}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.template-add-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const t = templates.find((x) => x.id === btn.dataset.tid);
      if (!t) return;
      let added = 0;
      for (const pid of (t.productIds || [])) {
        if (!shoppingList.some((s) => s.productId === pid && !s.done)) {
          const item = { id: uid(), productId: pid, done: false, addedAt: Date.now() };
          shoppingList.push(item);
          await dbPut(STORES.shoppingList, item);
          added++;
        }
      }
      showToast(`${added}商品をリストに追加しました`);
      renderProducts();
      renderShoppingList();
    });
  });

  list.querySelectorAll('[data-edit-tid]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTemplateModal(btn.dataset.editTid);
    });
  });
}

// ── RENDER: Prices ──
function renderPrices() {
  const list = document.getElementById('priceList');
  const empty = document.getElementById('priceEmpty');

  const productsWith = products.filter((p) => prices.some((x) => x.productId === p.id));

  if (!productsWith.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  list.innerHTML = productsWith.map((p) => {
    const pList = prices.filter((x) => x.productId === p.id).sort((a, b) => a.price - b.price);
    const minPrice = pList[0] ? pList[0].price : Infinity;

    return `<div class="price-card animate-in">
      <div class="price-card-header">
        <div class="price-thumb">
          ${p.imageDataUrl ? `<img src="${p.imageDataUrl}" alt="${escHtml(p.name)}">` : iconImage(18)}
        </div>
        <div class="price-product-name">${escHtml(p.name)}</div>
        ${pList.length ? `<span class="price-cheapest-badge">最安値 ${minPrice.toLocaleString()}円</span>` : ''}
      </div>
      <div class="price-rows">
        ${pList.map((pr) => {
          const store = storeNames.find((s) => s.id === pr.storeId);
          const isMin = pr.price === minPrice;
          return `<div class="price-row">
            <span class="price-store-name">${escHtml(store ? store.name : '不明')}</span>
            <span class="price-amount">${pr.price.toLocaleString()}円</span>
            ${isMin ? `<span class="price-cheapest-mark">✓ 最安</span>` : ''}
            <button class="shopping-remove-btn" data-prid="${pr.id}" title="削除">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>`;
        }).join('')}
      </div>
      <div class="price-add-row">
        <button class="btn btn-sm btn-outline" data-add-price-pid="${p.id}" style="width:auto;">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          価格を追加
        </button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-add-price-pid]').forEach((btn) => {
    btn.addEventListener('click', () => openPriceModal(btn.dataset.addPricePid));
  });

  list.querySelectorAll('[data-prid]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await showConfirm('価格を削除', 'この価格記録を削除しますか？');
      if (!ok) return;
      const prid = btn.dataset.prid;
      prices = prices.filter((x) => x.id !== prid);
      await dbDelete(STORES.prices, prid);
      renderPrices();
      renderProducts();
    });
  });
}

// ── RENDER: Settings ──
function renderSettings() {
  // Categories
  const catList = document.getElementById('categoryList');
  catList.innerHTML = categories.map((c) => `
    <div class="tag-chip">
      ${escHtml(c.name)}
      <button class="tag-chip-delete" data-delete-cat="${c.id}" title="削除">✕</button>
    </div>`).join('');
  catList.querySelectorAll('[data-delete-cat]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await showConfirm('カテゴリを削除', `このカテゴリを削除しますか？\n商品のカテゴリ設定はクリアされます。`);
      if (!ok) return;
      const id = btn.dataset.deleteCat;
      categories = categories.filter((c) => c.id !== id);
      await dbDelete(STORES.categories, id);
      for (const p of products.filter((x) => x.categoryId === id)) {
        p.categoryId = '';
        await dbPut(STORES.products, p);
      }
      renderSettings();
      renderCategoryFilter();
      renderProducts();
    });
  });

  // Stores
  const stList = document.getElementById('storeList');
  stList.innerHTML = storeNames.map((s) => `
    <div class="tag-chip">
      ${escHtml(s.name)}
      <button class="tag-chip-delete" data-delete-store="${s.id}" title="削除">✕</button>
    </div>`).join('');
  stList.querySelectorAll('[data-delete-store]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ok = await showConfirm('店舗を削除', 'この店舗を削除しますか？\n関連する価格データも削除されます。');
      if (!ok) return;
      const id = btn.dataset.deleteStore;
      const relatedPrices = prices.filter((p) => p.storeId === id);
      for (const pr of relatedPrices) await dbDelete(STORES.prices, pr.id);
      prices = prices.filter((p) => p.storeId !== id);
      storeNames = storeNames.filter((s) => s.id !== id);
      await dbDelete(STORES.storeNames, id);
      renderSettings();
      renderPrices();
    });
  });
}

// ── Product Modal ──
function openProductModal(id) {
  editingProductId = id;
  pendingImageDataUrl = null;
  const p = id ? products.find((x) => x.id === id) : null;

  document.getElementById('productModalTitle').textContent = p ? '商品を編集' : '商品を追加';
  document.getElementById('productNameInput').value = p ? p.name : '';
  document.getElementById('productMemoInput').value = p ? (p.memo || '') : '';
  document.getElementById('deleteProductBtn').style.display = p ? '' : 'none';

  // Image
  const area = document.getElementById('imgUploadArea');
  const existingImg = area.querySelector('img');
  if (existingImg) existingImg.remove();
  if (p && p.imageDataUrl) {
    const img = document.createElement('img');
    img.src = p.imageDataUrl;
    area.appendChild(img);
    pendingImageDataUrl = p.imageDataUrl;
  }

  // Category select
  const sel = document.getElementById('productCategorySelect');
  sel.innerHTML = `<option value="">-- カテゴリなし --</option>` +
    categories.map((c) => `<option value="${c.id}" ${p && p.categoryId === c.id ? 'selected' : ''}>${escHtml(c.name)}</option>`).join('');

  openModal('productModal');
  setTimeout(() => document.getElementById('productNameInput').focus(), 300);
}

document.getElementById('imgUploadArea').addEventListener('click', () => {
  document.getElementById('imgFileInput').click();
});

document.getElementById('imgFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingImageDataUrl = ev.target.result;
    const area = document.getElementById('imgUploadArea');
    const existing = area.querySelector('img');
    if (existing) existing.remove();
    const img = document.createElement('img');
    img.src = pendingImageDataUrl;
    area.appendChild(img);
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

document.getElementById('saveProductBtn').addEventListener('click', async () => {
  const name = document.getElementById('productNameInput').value.trim();
  if (!name) { showToast('商品名を入力してください'); return; }
  const categoryId = document.getElementById('productCategorySelect').value;
  const memo = document.getElementById('productMemoInput').value.trim();

  if (editingProductId) {
    const p = products.find((x) => x.id === editingProductId);
    p.name = name;
    p.categoryId = categoryId;
    p.memo = memo;
    p.imageDataUrl = pendingImageDataUrl || p.imageDataUrl || null;
    await dbPut(STORES.products, p);
    showToast('商品を更新しました');
  } else {
    const p = { id: uid(), name, categoryId, memo, imageDataUrl: pendingImageDataUrl || null, order: products.length };
    products.push(p);
    await dbPut(STORES.products, p);
    showToast('商品を追加しました');
  }

  closeModal('productModal');
  render();
});

document.getElementById('deleteProductBtn').addEventListener('click', async () => {
  const p = products.find((x) => x.id === editingProductId);
  if (!p) return;
  const ok = await showConfirm('商品を削除', `「${p.name}」を削除しますか？\n関連する価格・リストデータも削除されます。`);
  if (!ok) return;

  products = products.filter((x) => x.id !== editingProductId);
  await dbDelete(STORES.products, editingProductId);

  const relPrices = prices.filter((x) => x.productId === editingProductId);
  for (const pr of relPrices) await dbDelete(STORES.prices, pr.id);
  prices = prices.filter((x) => x.productId !== editingProductId);

  const relList = shoppingList.filter((x) => x.productId === editingProductId);
  for (const s of relList) await dbDelete(STORES.shoppingList, s.id);
  shoppingList = shoppingList.filter((x) => x.productId !== editingProductId);

  closeModal('productModal');
  showToast('商品を削除しました');
  render();
});

document.getElementById('cancelProductBtn').addEventListener('click', () => closeModal('productModal'));

// ── Template Modal ──
function openTemplateModal(id) {
  editingTemplateId = id;
  const t = id ? templates.find((x) => x.id === id) : null;

  document.getElementById('templateModalTitle').textContent = t ? 'テンプレートを編集' : 'テンプレートを作成';
  document.getElementById('templateNameInput').value = t ? t.name : '';
  document.getElementById('deleteTemplateBtn').style.display = t ? '' : 'none';

  const checks = document.getElementById('templateProductChecks');
  checks.innerHTML = products.map((p) => {
    const checked = t && (t.productIds || []).includes(p.id);
    return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;">
      <input type="checkbox" value="${p.id}" ${checked ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--primary);">
      ${escHtml(p.name)}
    </label>`;
  }).join('');

  openModal('templateModal');
}

document.getElementById('saveTemplateBtn').addEventListener('click', async () => {
  const name = document.getElementById('templateNameInput').value.trim();
  if (!name) { showToast('テンプレート名を入力してください'); return; }
  const checked = [...document.getElementById('templateProductChecks').querySelectorAll('input:checked')];
  const productIds = checked.map((c) => c.value);

  if (editingTemplateId) {
    const t = templates.find((x) => x.id === editingTemplateId);
    t.name = name;
    t.productIds = productIds;
    await dbPut(STORES.templates, t);
    showToast('テンプレートを更新しました');
  } else {
    const t = { id: uid(), name, productIds };
    templates.push(t);
    await dbPut(STORES.templates, t);
    showToast('テンプレートを作成しました');
  }

  closeModal('templateModal');
  renderTemplates();
});

document.getElementById('deleteTemplateBtn').addEventListener('click', async () => {
  const t = templates.find((x) => x.id === editingTemplateId);
  if (!t) return;
  const ok = await showConfirm('テンプレートを削除', `「${t.name}」を削除しますか？`);
  if (!ok) return;
  templates = templates.filter((x) => x.id !== editingTemplateId);
  await dbDelete(STORES.templates, editingTemplateId);
  closeModal('templateModal');
  showToast('テンプレートを削除しました');
  renderTemplates();
});

document.getElementById('cancelTemplateBtn').addEventListener('click', () => closeModal('templateModal'));

// ── Price Modal ──
function openPriceModal(productId) {
  editingPriceProductId = productId;
  const p = products.find((x) => x.id === productId);
  document.getElementById('priceModalTitle').textContent = `価格を登録 — ${p ? p.name : ''}`;

  const sel = document.getElementById('priceStoreSelect');
  sel.innerHTML = `<option value="">-- 店舗を選択 --</option>` +
    storeNames.map((s) => `<option value="${s.id}">${escHtml(s.name)}</option>`).join('');

  document.getElementById('priceAmountInput').value = '';
  openModal('priceModal');
}

document.getElementById('savePriceBtn').addEventListener('click', async () => {
  const storeId = document.getElementById('priceStoreSelect').value;
  const amount = parseInt(document.getElementById('priceAmountInput').value, 10);
  if (!storeId) { showToast('店舗を選択してください'); return; }
  if (isNaN(amount) || amount < 0) { showToast('価格を正しく入力してください'); return; }

  // Update existing or add
  const existing = prices.find((p) => p.productId === editingPriceProductId && p.storeId === storeId);
  if (existing) {
    existing.price = amount;
    await dbPut(STORES.prices, existing);
  } else {
    const pr = { id: uid(), productId: editingPriceProductId, storeId, price: amount };
    prices.push(pr);
    await dbPut(STORES.prices, pr);
  }

  closeModal('priceModal');
  showToast('価格を保存しました');
  renderPrices();
  renderProducts();
});

document.getElementById('cancelPriceBtn').addEventListener('click', () => closeModal('priceModal'));

// ── Share ──
document.getElementById('shareListBtn').addEventListener('click', () => {
  const pending = shoppingList.filter((s) => !s.done);
  if (!pending.length) { showToast('リストが空です'); return; }

  const preview = document.getElementById('sharePreview');
  preview.innerHTML = pending.map((s) => {
    const p = products.find((x) => x.id === s.productId);
    const name = p ? p.name : '不明';
    const img = p && p.imageDataUrl ? `<img src="${p.imageDataUrl}" alt="${escHtml(name)}">` : iconImage(20);
    return `<div class="share-item">
      <div class="share-thumb">${img}</div>
      <div class="share-item-name">${escHtml(name)}</div>
    </div>`;
  }).join('');

  openModal('shareModal');
});

document.getElementById('doShareBtn').addEventListener('click', async () => {
  const pending = shoppingList.filter((s) => !s.done);
  const lines = pending.map((s) => {
    const p = products.find((x) => x.id === s.productId);
    return '☐ ' + (p ? p.name : '不明');
  });
  const text = '【買い物リスト】\n' + lines.join('\n');

  if (navigator.share) {
    try {
      await navigator.share({ title: '買い物リスト', text });
    } catch (e) {
      if (e.name !== 'AbortError') showToast('共有に失敗しました');
    }
  } else {
    await navigator.clipboard.writeText(text).catch(() => {});
    showToast('リストをコピーしました');
  }
  closeModal('shareModal');
});

document.getElementById('cancelShareBtn').addEventListener('click', () => closeModal('shareModal'));

// ── Clear done ──
document.getElementById('clearDoneBtn').addEventListener('click', async () => {
  const done = shoppingList.filter((s) => s.done);
  if (!done.length) { showToast('購入済み商品はありません'); return; }
  const ok = await showConfirm('購入済みを削除', `購入済みの${done.length}商品をリストから削除しますか？`);
  if (!ok) return;
  for (const s of done) await dbDelete(STORES.shoppingList, s.id);
  shoppingList = shoppingList.filter((s) => !s.done);
  renderShoppingList();
  renderProducts();
});

// ── Settings buttons ──
document.getElementById('addCategoryBtn').addEventListener('click', async () => {
  const val = document.getElementById('newCategoryInput').value.trim();
  if (!val) return;
  if (categories.some((c) => c.name === val)) { showToast('同じ名前のカテゴリがあります'); return; }
  const c = { id: uid(), name: val, order: categories.length };
  categories.push(c);
  await dbPut(STORES.categories, c);
  document.getElementById('newCategoryInput').value = '';
  renderSettings();
  renderCategoryFilter();
});

document.getElementById('newCategoryInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('addCategoryBtn').click();
});

document.getElementById('addStoreBtn').addEventListener('click', async () => {
  const val = document.getElementById('newStoreInput').value.trim();
  if (!val) return;
  if (storeNames.some((s) => s.name === val)) { showToast('同じ名前の店舗があります'); return; }
  const s = { id: uid(), name: val };
  storeNames.push(s);
  await dbPut(STORES.storeNames, s);
  document.getElementById('newStoreInput').value = '';
  renderSettings();
});

document.getElementById('newStoreInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('addStoreBtn').click();
});

// ── Export ──
document.getElementById('exportBtn').addEventListener('click', async () => {
  const data = { products, categories, storeNames, templates, prices, shoppingList, exportedAt: Date.now() };
  // Remove large imageDataUrl for readability but keep it
  const json = JSON.stringify(data);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `kaimono-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('バックアップを保存しました');
});

// ── Import ──
document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFileInput').click();
});

document.getElementById('importFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ok = await showConfirm('データを復元', '現在のデータを上書きしてバックアップから復元しますか？', '復元する');
  if (!ok) { e.target.value = ''; return; }

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const allStores = Object.values(STORES);
    for (const s of allStores) await dbClear(s);

    products = data.products || [];
    categories = data.categories || [];
    storeNames = data.storeNames || [];
    templates = data.templates || [];
    prices = data.prices || [];
    shoppingList = data.shoppingList || [];

    for (const s of Object.values(STORES)) {
      const arr = { products, categories, storeNames, templates, prices, shoppingList }[s] || [];
      for (const item of arr) await dbPut(s, item);
    }

    showToast('データを復元しました');
    render();
  } catch {
    showToast('ファイルの読み込みに失敗しました');
  }
  e.target.value = '';
});

// ── Clear all ──
document.getElementById('clearAllBtn').addEventListener('click', async () => {
  const ok = await showConfirm('全データを削除', '全てのデータを削除しますか？この操作は取り消せません。');
  if (!ok) return;
  for (const s of Object.values(STORES)) await dbClear(s);
  products = []; categories = []; storeNames = []; templates = []; prices = []; shoppingList = [];
  showToast('全データを削除しました');
  render();
});

// ── Drag Sort ──
function initDragSort(container, cardSelector, onReorder) {
  let dragging = null;
  let dragOverEl = null;

  container.querySelectorAll(cardSelector).forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      if (!sortMode) { e.preventDefault(); return; }
      dragging = card;
      setTimeout(() => card.style.opacity = '0.4', 0);
      e.dataTransfer.effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      card.style.opacity = '';
      dragging = null;
      container.querySelectorAll(cardSelector).forEach((c) => c.classList.remove('drag-over'));
      const ids = [...container.querySelectorAll(cardSelector)].map((c) => c.dataset.id);
      onReorder(ids);
    });

    card.addEventListener('dragover', (e) => {
      if (!sortMode || !dragging || dragging === card) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragOverEl !== card) {
        container.querySelectorAll(cardSelector).forEach((c) => c.classList.remove('drag-over'));
        dragOverEl = card;
        card.classList.add('drag-over');
        const rect = card.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        container.insertBefore(dragging, after ? card.nextSibling : card);
      }
    });
  });
}

// ── Helpers ──
function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function iconImage(size = 22) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
}

// ── Master render ──
function render() {
  renderCategoryFilter();
  renderProducts();
  renderShoppingList();
  renderTemplates();
  renderPrices();
  renderSettings();
}

// ── Init ──
(async () => {
  await openDB();
  await loadAll();
  render();
})();
