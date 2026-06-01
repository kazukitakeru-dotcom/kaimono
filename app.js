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
  renderProducts();
});

sortDoneBtn.addEventListener('click', exitSortMode);

function exitSortMode() {
  sortMode = false;
  sortModeBar.classList.remove('visible');
  document.getElementById('productList').classList.remove('sort-mode');
  renderProducts();
}

// ── 並び替え: 矢印ボタンで上下移動 ──
async function moveProduct(id, dir) {
  const idx = products.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= products.length) return;
  // swap
  [products[idx], products[targetIdx]] = [products[targetIdx], products[idx]];
  // save order
  for (let i = 0; i < products.length; i++) {
    products[i].order = i;
    await dbPut(STORES.products, products[i]);
  }
  renderProducts();
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

  list.innerHTML = filtered.map((p, i) => {
    const cat = categories.find((c) => c.id === p.categoryId);
    const cheapest = getCheapestPrice(p.id);
    const inList = shoppingList.some((s) => s.productId === p.id && !s.done);
    const isFirst = i === 0;
    const isLast = i === filtered.length - 1;

    return `<div class="product-card animate-in" data-id="${p.id}">
      ${sortMode ? `
      <div class="sort-arrows">
        <button class="sort-arrow-btn" data-move-id="${p.id}" data-dir="-1" ${isFirst ? 'disabled' : ''} title="上へ">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
        <button class="sort-arrow-btn" data-move-id="${p.id}" data-dir="1" ${isLast ? 'disabled' : ''} title="下へ">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>` : ''}
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
        ${!sortMode ? `<button class="add-to-list-btn ${inList ? 'in-list' : ''}" data-id="${p.id}" title="${inList ? 'リストに追加済み' : 'リストに追加'}">
          ${inList
            ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
            : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
          }
        </button>` : ''}
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.product-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.add-to-list-btn') || e.target.closest('.sort-arrow-btn')) return;
      if (sortMode) return;
      openProductModal(card.dataset.id);
    });
  });

  list.querySelectorAll('.add-to-list-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleShoppingList(btn.dataset.id);
    });
  });

  list.querySelectorAll('.sort-arrow-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      moveProduct(btn.dataset.moveId, parseInt(btn.dataset.dir, 10));
    });
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

  // 価格セクション：店舗ごとに入力欄を表示
  renderProductPriceSection(id);

  openModal('productModal');
  setTimeout(() => document.getElementById('productNameInput').focus(), 300);
}

// 商品モーダル内の価格設定セクション
function renderProductPriceSection(productId) {
  const section = document.getElementById('productPriceSection');
  if (!storeNames.length) {
    section.innerHTML = `<p style="font-size:13px;color:var(--text-muted);padding:8px 0;">設定タブで店舗を先に追加してください。</p>`;
    return;
  }

  const productPrices = productId ? prices.filter((pr) => pr.productId === productId) : [];

  section.innerHTML = storeNames.map((s) => {
    const existing = productPrices.find((pr) => pr.storeId === s.id);
    return `<div class="price-input-row">
      <span class="price-input-store">${escHtml(s.name)}</span>
      <div class="price-input-wrap">
        <input class="form-input price-inline-input" type="number" min="0"
          data-store-id="${s.id}"
          placeholder="未登録"
          value="${existing ? existing.price : ''}">
        <span class="price-input-yen">円</span>
      </div>
    </div>`;
  }).join('');
}

// 商品保存時に価格も一緒に保存
async function saveProductPrices(productId) {
  const inputs = document.querySelectorAll('.price-inline-input');
  for (const input of inputs) {
    const storeId = input.dataset.storeId;
    const val = input.value.trim();
    const existing = prices.find((pr) => pr.productId === productId && pr.storeId === storeId);

    if (val === '' || val === null) {
      // 空なら既存を削除
      if (existing) {
        prices = prices.filter((pr) => pr.id !== existing.id);
        await dbDelete(STORES.prices, existing.id);
      }
    } else {
      const amount = parseInt(val, 10);
      if (isNaN(amount) || amount < 0) continue;
      if (existing) {
        existing.price = amount;
        await dbPut(STORES.prices, existing);
      } else {
        const pr = { id: uid(), productId, storeId, price: amount };
        prices.push(pr);
        await dbPut(STORES.prices, pr);
      }
    }
  }
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

  let savedProductId;

  if (editingProductId) {
    const p = products.find((x) => x.id === editingProductId);
    p.name = name;
    p.categoryId = categoryId;
    p.memo = memo;
    p.imageDataUrl = pendingImageDataUrl || p.imageDataUrl || null;
    await dbPut(STORES.products, p);
    savedProductId = editingProductId;
    showToast('商品を更新しました');
  } else {
    const p = { id: uid(), name, categoryId, memo, imageDataUrl: pendingImageDataUrl || null, order: products.length };
    products.push(p);
    await dbPut(STORES.products, p);
    savedProductId = p.id;
    showToast('商品を追加しました');
  }

  await saveProductPrices(savedProductId);

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

// ── Price Modal（価格タブの「価格を追加」ボタン用） ──
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

// ── Share: Canvas で画像合成 ──
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
  if (!pending.length) return;

  // Canvas で買い物リスト画像を合成
  try {
    const imageBlob = await buildShareImage(pending);
    const text = '【買い物リスト】\n' + pending.map((s) => {
      const p = products.find((x) => x.id === s.productId);
      return '☐ ' + (p ? p.name : '不明');
    }).join('\n');

    if (navigator.share && navigator.canShare) {
      const file = new File([imageBlob], 'kaimono-list.png', { type: 'image/png' });
      const shareData = { title: '買い物リスト', text, files: [file] };
      if (navigator.canShare(shareData)) {
        try {
          await navigator.share(shareData);
          closeModal('shareModal');
          return;
        } catch (e) {
          if (e.name === 'AbortError') { closeModal('shareModal'); return; }
        }
      }
    }
    // ファイル共有非対応の場合は画像をダウンロード
    const url = URL.createObjectURL(imageBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kaimono-list.png';
    a.click();
    URL.revokeObjectURL(url);
    showToast('画像を保存しました（LINEなどで送ってください）');
    closeModal('shareModal');
  } catch (err) {
    // Canvas 失敗時はテキストのみ共有
    const text = '【買い物リスト】\n' + pending.map((s) => {
      const p = products.find((x) => x.id === s.productId);
      return '☐ ' + (p ? p.name : '不明');
    }).join('\n');
    if (navigator.share) {
      try { await navigator.share({ title: '買い物リスト', text }); } catch {}
    } else {
      await navigator.clipboard.writeText(text).catch(() => {});
      showToast('リストをコピーしました');
    }
    closeModal('shareModal');
  }
});

// Canvas で商品カード画像を1枚に合成する
async function buildShareImage(items) {
  const CARD_W = 480;
  const CARD_H = 88;
  const THUMB = 64;
  const PADDING = 12;
  const HEADER_H = 56;
  const FOOTER_H = 32;
  const totalH = HEADER_H + items.length * CARD_H + FOOTER_H;

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d');

  // 背景
  ctx.fillStyle = '#FAFAF8';
  ctx.fillRect(0, 0, CARD_W, totalH);

  // ヘッダー
  ctx.fillStyle = '#3D6B4F';
  ctx.fillRect(0, 0, CARD_W, HEADER_H);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('買い物リスト', PADDING + 4, HEADER_H / 2);

  // 商品カード
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    const p = products.find((x) => x.id === s.productId);
    const name = p ? p.name : '不明';
    const memo = p ? (p.memo || '') : '';
    const cheapest = p ? getCheapestPrice(p.id) : null;
    const y = HEADER_H + i * CARD_H;

    // カード背景
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#F7F5F0';
    ctx.fillRect(0, y, CARD_W, CARD_H);

    // 区切り線
    ctx.strokeStyle = '#E4E0D8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + CARD_H);
    ctx.lineTo(CARD_W, y + CARD_H);
    ctx.stroke();

    // サムネイル枠
    const thumbX = PADDING;
    const thumbY = y + (CARD_H - THUMB) / 2;
    ctx.fillStyle = '#F2F0EB';
    roundRect(ctx, thumbX, thumbY, THUMB, THUMB, 8);
    ctx.fill();

    // 商品画像
    if (p && p.imageDataUrl) {
      try {
        const img = await loadImage(p.imageDataUrl);
        ctx.save();
        roundRect(ctx, thumbX, thumbY, THUMB, THUMB, 8);
        ctx.clip();
        ctx.drawImage(img, thumbX, thumbY, THUMB, THUMB);
        ctx.restore();
      } catch {}
    } else {
      // 画像なしアイコン
      ctx.fillStyle = '#B0AA9F';
      ctx.font = '28px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🛍', thumbX + THUMB / 2, thumbY + THUMB / 2);
      ctx.textAlign = 'left';
    }

    // テキスト
    const textX = thumbX + THUMB + PADDING;
    ctx.fillStyle = '#1C1C1A';
    ctx.font = 'bold 16px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(name, textX, y + 18);

    if (memo) {
      ctx.fillStyle = '#7A7568';
      ctx.font = '12px sans-serif';
      ctx.fillText(memo, textX, y + 38);
    }

    if (cheapest) {
      ctx.fillStyle = '#C17A3A';
      ctx.font = '12px sans-serif';
      ctx.fillText(`最安値: ${cheapest.storeName} ${cheapest.price.toLocaleString()}円`, textX, y + (memo ? 54 : 40));
    }
  }

  // フッター
  const fy = HEADER_H + items.length * CARD_H;
  ctx.fillStyle = '#F2F0EB';
  ctx.fillRect(0, fy, CARD_W, FOOTER_H);
  ctx.fillStyle = '#B0AA9F';
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText('買い物メモ', CARD_W - PADDING, fy + FOOTER_H / 2);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

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
