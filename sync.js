'use strict';

/* ==========================================================================
   買い物メモ — 複数端末同期（Supabase）

   6ストアとも「IDを持つレコードの集合」なので、行単位の last-write-wins ＋ 墓標。
   このアプリで一番大事なのは墓標。

   買い物リストは「買い終わったら消す」作りになっている。墓標が無いと、
   スマホでチェックして消した品物が、まだ持っているPCから押し戻されて
   リストに復活してしまう。app.js の dbDelete / dbClear が自動で墓標を残す。

   外部ライブラリは使わない（PWAをオフラインで完結させるため fetch で直接叩く）。
   ========================================================================== */

const SB_URL = 'https://kafaarlosuvqxxlxpvgg.supabase.co';
const SB_KEY = 'sb_publishable_nSwOQo-YbEtDN_KTjBf80w_D6o0iLoA';

// ログイン状態は6アプリで共通。同じオリジンなので localStorage を共有できる。
// キーを分けていたせいで、アプリの数だけログインが必要になっていた。
const SESSION_KEY    = 'sb_session_v1';
const LEGACY_SESSION_KEY = 'kaimono_session_v1';
const SYNC_STATE_KEY = 'kaimono_sync_state_v1';
const ROLLBACK_KEY   = 'kaimono_rollback_v1';

// サーバー時刻でも「commit の順番」と now() は完全には一致しないので、
// 前回取得位置を少しだけ巻き戻して取りこぼしを防ぐ。重複して取っても害はない。
const PULL_MARGIN_MS = 5000;
const PAGE_SIZE = 1000; // PostgREST の1回あたり上限に合わせる

// 商品画像が入るので1回の送信量が大きくなりやすい。少なめに刻む。
const PUSH_CHUNK = 50;

// 墓標として送った項目の目印
const DELETED_SIG = 'X';

// ========== セッション ==========
function sbLoadSession() {
  try {
    let raw = localStorage.getItem(SESSION_KEY);
    // 旧キー（アプリごとに分かれていた頃のもの）からの引き継ぎ。
    // これがあるので、共通化のためにログインし直す必要はない。
    if (!raw) {
      const old = localStorage.getItem(LEGACY_SESSION_KEY);
      // 引き継いだら古いほうは必ず消す。残すとログアウトした瞬間に古いログイン情報が
      // ここから復活し、何週間も前の更新トークンを使ってサーバーにログインごと無効にされていた
      if (old) { localStorage.setItem(SESSION_KEY, old); localStorage.removeItem(LEGACY_SESSION_KEY); raw = old; }
    }
    return JSON.parse(raw || 'null');
  } catch (e) { return null; }
}
/* アプリごとに分かれていた頃のログイン情報の置き場所。6アプリは同じオリジンで保存先を共有しているので、
   どのアプリの古いキーが残っていても、ログアウトや失効のあとに古いログイン情報が復活してしまう。
   ログインした時もログアウトした時も、全部まとめて消す。 */
const LEGACY_SESSION_KEYS = ['ironlog_session_v1', 'wannyan_session_v1', 'uruoi_session_v1', 'qest_session_v1', 'kaimono_session_v1'];

function sbSaveSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
  LEGACY_SESSION_KEYS.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
}
function sbIsLoggedIn() { return !!(sbLoadSession() || {}).refresh_token; }

/* 最後にログインしたメールアドレス。ログイン欄にあらかじめ入れておくためだけのもので、
   パスワードは持たない（パスワードは端末のパスワード保存に任せる）。
   キーは他アプリと共通なので、どれか1つで入れれば他アプリの欄にも入っている。 */
const LAST_EMAIL_KEY = 'sb_last_email';
function lastLoginEmail() {
  return (sbLoadSession() || {}).email || localStorage.getItem(LAST_EMAIL_KEY) || '';
}
function rememberLoginEmail(email) {
  try { localStorage.setItem(LAST_EMAIL_KEY, email); } catch (e) {}
}

function _storeSession(json) {
  if (!json || !json.access_token) return null;
  const prev = sbLoadSession() || {};
  const s = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
    user_id: (json.user && json.user.id) || prev.user_id || null,
    email: (json.user && json.user.email) || prev.email || null,
  };
  sbSaveSession(s);
  return s;
}

async function _authFetch(path, body) {
  const res = await fetch(`${SB_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 「サーバーに断られた」のか「そもそも届かなかった」のかを呼び出し側が区別できるように
    // status を付ける。混同するとオフラインなだけでログイン情報を捨ててしまう。
    const err = new Error(json.error_description || json.msg || json.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function sbSignUp(email, password) {
  const json = await _authFetch('signup', { email, password });
  if (!json.access_token) return { needsConfirmation: true }; // メール確認が有効な場合
  _storeSession(json);
  return { needsConfirmation: false };
}

async function sbSignIn(email, password) {
  _storeSession(await _authFetch('token?grant_type=password', { email, password }));
}

function sbSignOut() {
  sbSaveSession(null);
  _saveSyncState(null);
}

// 有効なアクセストークンを返す（期限が近ければ更新する）
//
// リフレッシュトークンは1回使うとサーバー側で作り替えられ、古いものはその場で無効になる。
// 同期は複数のテーブルを Promise.all で同時に取りに行くので、何もしないと
// 各リクエストが同時に「期限が切れているから更新しよう」と判断して同じトークンを何度も使い、
// 1本だけ成功して残りは「Invalid Refresh Token: Already Used」で弾かれる。
// それを失効と誤解してログイン情報を消していたため、
// アクセストークンの寿命（1時間）を超えて間を空けるたびにログインし直しになっていた。
// _refreshing で更新は常に1本にまとめ、後続はその結果に相乗りする。
let _refreshing = null;

async function sbAccessToken() {
  const s = sbLoadSession();
  if (!s || !s.refresh_token) return null;
  if (s.access_token && Date.now() < s.expires_at - 60000) return s.access_token;
  if (!_refreshing) {
    _refreshing = _refreshExclusive().finally(() => { _refreshing = null; });
  }
  return _refreshing;
}

/* github.io の6アプリは同じオリジンなので、ログイン情報の保存先（sb_session_v1）を共有している。
   別のタブや別のアプリが同時に同じ更新トークンを使うと、Supabase はそれを「使い回し」とみなし、
   そのログインを丸ごと無効にすることがある（以後どのアプリでも Invalid Refresh Token: Already Used）。
   Web Locks でオリジン全体の更新を1本ずつに並べ、鍵が取れた時点で保存先を読み直す。
   待っている間に誰かが更新を済ませていれば、それをそのまま使う。 */
function _refreshExclusive() {
  const run = async () => {
    const s = sbLoadSession();
    if (!s || !s.refresh_token) throw new Error('ログインしていません');
    if (s.access_token && Date.now() < s.expires_at - 60000) return s.access_token;
    return _sbRefresh(s.refresh_token);
  };
  return (navigator.locks && navigator.locks.request)
    ? navigator.locks.request('sb-token-refresh', run)
    : run();
}

async function _sbRefresh(used) {
  try {
    const json = await _authFetch('token?grant_type=refresh_token', { refresh_token: used });
    return _storeSession(json).access_token;
  } catch (e) {
    // 同じオリジンの別アプリ／別タブが先に更新していた場合、保存先には既に新しいものが入っている。
    // これは失効ではないので、ログイン情報は捨てずに新しいほうで1回だけやり直す。
    const now = sbLoadSession();
    if (now && now.refresh_token && now.refresh_token !== used) {
      if (now.access_token && Date.now() < now.expires_at - 60000) return now.access_token;
      try {
        const json = await _authFetch('token?grant_type=refresh_token', { refresh_token: now.refresh_token });
        return _storeSession(json).access_token;
      } catch (e2) {
        e = e2;   // やり直しも断られたら、下で同じように扱う
      }
    }
    // サーバーがはっきり断ったときだけログインし直し。通信エラー（status 無し）では捨てない。
    // 以前は「やり直し」が断られたときにここを通らず、使えないログイン情報が残ったまま
    // 同期のたびに Invalid Refresh Token: Already Used が出続けていた。
    if (e.status === 400 || e.status === 401) {
      sbSaveSession(null);
      const err = new Error('ログインの有効期限が切れました。もう一度ログインしてください');
      err.status = e.status;
      throw err;
    }
    throw e;
  }
}

// ========== データAPI ==========
async function _rest(path, { method = 'GET', body = null, prefer = null } = {}) {
  const token = await sbAccessToken();
  if (!token) throw new Error('ログインしていません');
  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status} ${t.slice(0, 200)}`);
  }
  if (method === 'GET') return res.json().catch(() => []);
  return null;
}

// 1回のGETには件数上限があるので、全部取れるまでページを送る。
// 価格の記録は買い物のたびに増えるので、ここを忘れると古い記録が静かに欠ける。
async function _restAll(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await _rest(`${path}&limit=${PAGE_SIZE}&offset=${offset}`);
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
  }
}

async function _restUpsert(path, rows) {
  for (let i = 0; i < rows.length; i += PUSH_CHUNK) {
    await _rest(path, {
      method: 'POST',
      body: rows.slice(i, i + PUSH_CHUNK),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }
}

// ========== 変更検出 ==========
function _hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 + c) * 31 + (h2 << 3)) >>> 0;
  }
  return h1.toString(36) + '-' + h2.toString(36) + '-' + str.length.toString(36);
}

// Postgres の jsonb はキーの並び順を保たない。
// 素の JSON.stringify で比べると、中身が同じでも「変わった」と誤判定して
// 送り直しが起き続けるので、キーを並べ替えてから文字列にする。
function _stable(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_stable).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .map(k => JSON.stringify(k) + ':' + _stable(v[k])).join(',') + '}';
}
function _sig(v) { return _hash(_stable(v)); }

function _key(store, id) { return `${store}:${id}`; }

function _emptySyncState() {
  return {
    initialized: false,
    lastPulledAt: null,
    // 'store:id' -> サーバーと一致していると分かっている内容のハッシュ（削除なら 'X'）
    items: {},
    lastSyncedAt: null,
  };
}
function _loadSyncState() {
  try {
    const s = JSON.parse(localStorage.getItem(SYNC_STATE_KEY) || 'null');
    return (s && typeof s === 'object') ? Object.assign(_emptySyncState(), s) : _emptySyncState();
  } catch (e) { return _emptySyncState(); }
}
function _saveSyncState(s) {
  if (s) localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(s));
  else localStorage.removeItem(SYNC_STATE_KEY);
}

// ========== 取り込み前の巻き戻し用スナップショット ==========
// クラウドの内容を反映する直前に、この端末のデータを丸ごと控えておく。
// 商品画像込みだと localStorage に収まらないことがあるので、IndexedDB に置く。
async function saveRollback(reason) {
  try {
    const snap = { id: 'rollback', at: Date.now(), reason, stores: {} };
    let total = 0;
    for (const s of DATA_STORES) {
      snap.stores[s] = await dbAll(s);
      total += snap.stores[s].length;
    }
    if (!total) return; // 空を控えても意味がない
    await dbRawPut(SYNC_STORE, { id: ROLLBACK_KEY, snapshot: snap });
  } catch (e) { /* 保険が取れなくても本処理は止めない */ }
}

async function loadRollback() {
  try {
    const row = await dbGet(SYNC_STORE, ROLLBACK_KEY);
    return (row && row.snapshot) || null;
  } catch (e) { return null; }
}

async function restoreRollback() {
  const snap = await loadRollback();
  if (!snap) { alert('戻せる控えがありません。'); return; }
  const when = new Date(snap.at).toLocaleString('ja-JP');
  const n = (snap.stores.products || []).length;
  if (!confirm(`${when} 時点の内容（商品${n}件）に戻します。\n今この端末にあるデータは置き換わります。よろしいですか？`)) return;

  for (const s of DATA_STORES) {
    for (const item of await dbAll(s)) await dbRawDelete(s, item.id);
    for (const item of snap.stores[s] || []) await dbRawPut(s, item);
  }
  // 送信済みの目印を消して、戻した内容を改めてクラウドへ反映させる
  _saveSyncState(null);
  alert('戻しました。再読み込みします。');
  location.reload();
}

// ========== 同期本体 ==========
let _syncing = false;
let _syncTimer = null;
let _lastSyncError = null;

function scheduleSync(delay = 2500) {
  if (!sbIsLoggedIn()) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

// app.js の dbPut / dbDelete / dbClear から呼ばれる
window.kaimonoOnLocalChange = function () { scheduleSync(); };

// app.js の初期化が終わったら呼ばれる
window.kaimonoOnReady = function () {
  updateSyncUI();
  scheduleSync(1200);
};

// この端末で初めて同期するときだけ、合流するか置き換えるかを決める。
async function firstSyncSetup(sync) {
  if (sync.initialized) return;

  const n = (await dbAll(STORES.products)).length;
  if (n > 0) {
    await saveRollback('初回同期の前');
    const merge = confirm(
      `この端末には ${n}件 の商品があります。\n\n` +
      `［OK］この端末の内容もクラウドに合流させる\n` +
      `［キャンセル］クラウドの内容だけを取り込む\n\n` +
      `どちらを選んでも、今の内容は控えに保存され、あとから戻せます。`
    );
    if (!merge) {
      for (const s of DATA_STORES) {
        for (const item of await dbAll(s)) await dbRawDelete(s, item.id);
      }
      // 置き換えを選んだので、消した記録（墓標）も引き継がない
      for (const t of await dbAll(TOMB_STORE)) await dbRawDelete(TOMB_STORE, t.id);
    }
  }
  sync.initialized = true;
  _saveSyncState(sync);
}

// app.js が IndexedDB を開き終わるのを待つ
async function _waitForDb() {
  for (let i = 0; i < 100 && !db; i++) await new Promise(r => setTimeout(r, 100));
  if (!db) throw new Error('データベースを開けていません');
}

async function syncNow(opts = {}) {
  if (_syncing) return;
  if (!sbIsLoggedIn()) return;
  if (!navigator.onLine) { _lastSyncError = 'オフライン'; updateSyncUI(); return; }

  _syncing = true;
  updateSyncUI();
  try {
    await _waitForDb();
    const sync = _loadSyncState();
    await firstSyncSetup(sync);
    await _pull(sync);
    await _push(sync);
    sync.lastSyncedAt = Date.now();
    _saveSyncState(sync);
    _lastSyncError = null;
    if (opts.toast) showToast('同期しました');
  } catch (e) {
    _lastSyncError = e.message || String(e);
    if (opts.toast) alert('同期に失敗しました：' + _lastSyncError);
  } finally {
    _syncing = false;
    updateSyncUI();
  }
}

// この端末での「今の姿」。サーバーと一致しているかの判定に使う。
// 消してある場合は 'X'、そもそも無い場合は null。
async function _localSig(store, id) {
  const item = await dbGet(store, id);
  if (item) return _sig(item);
  const tomb = await dbGet(TOMB_STORE, tombKey(store, id));
  return tomb ? DELETED_SIG : null;
}

// ---- 取得 ----
async function _pull(sync) {
  // 手元が空なのに同期の記録だけ残っている＝ブラウザに保存領域を回収されたなど、
  // 消えるはずのない消え方をした状態。差分だけ取っても戻らないので全件取り直す。
  if (sync.lastPulledAt && Object.keys(sync.items).length) {
    let n = 0;
    for (const s of DATA_STORES) n += await dbCount(s);
    if (n === 0) sync.lastPulledAt = null;
  }
  const since = sync.lastPulledAt ? `&updated_at=gt.${encodeURIComponent(sync.lastPulledAt)}` : '';
  const rows = await _restAll(
    `kaimono_items?select=store,id,data,deleted,updated_at&order=updated_at.asc,id.asc${since}`
  );
  if (!rows.length) return;

  // これから端末のデータを書き換えるので、直前の状態を控えておく
  await saveRollback('取り込み前');

  let newest = null;
  const bump = ts => { if (ts && (!newest || ts > newest)) newest = ts; };

  for (const row of rows) {
    bump(row.updated_at);
    if (!DATA_STORES.includes(row.store)) continue;
    const k = _key(row.store, row.id);

    // この端末にまだ送っていない変更があるなら、そちらを残す。
    // 送信側でサーバーに反映されるので、結局は新しい方に揃う。
    // ただし sig が null（手元に無く、墓標も無い）ときは「消したから無い」のではなく
    // 「理由なく消えている」状態なので、ローカル変更とは見なさずサーバーの内容を取り戻す。
    // ブラウザに保存領域を回収されると、これが無いと二度と復元できなくなる。
    const sig = await _localSig(row.store, row.id);
    if (sig !== null && sync.items[k] !== undefined && sync.items[k] !== sig) continue;

    if (row.deleted) {
      await dbRawDelete(row.store, row.id);
      // 手元にも墓標を残す。残さないと次回こちらから押し戻してしまう。
      await dbRawPut(TOMB_STORE, {
        id: k, store: row.store, itemId: row.id,
        at: Date.parse(row.updated_at) || Date.now(),
      });
      sync.items[k] = DELETED_SIG;
    } else {
      await dbRawPut(row.store, row.data);
      await dbRawDelete(TOMB_STORE, k);
      sync.items[k] = _sig(row.data);
    }
  }

  if (newest) {
    sync.lastPulledAt = new Date(Date.parse(newest) - PULL_MARGIN_MS).toISOString();
  }

  await loadAll();
  try { render(); } catch (e) {}
}

// ---- 送信 ----
async function _push(sync) {
  const userId = (sbLoadSession() || {}).user_id;
  if (!userId) throw new Error('ユーザーIDが取れません');

  const rows = [];

  // --- 手元にある項目のうち、サーバーと違うもの ---
  for (const store of DATA_STORES) {
    for (const item of await dbAll(store)) {
      const k = _key(store, item.id);
      const sig = _sig(item);
      if (sync.items[k] === sig) continue;
      rows.push({ user_id: userId, store, id: item.id, data: item, deleted: false });
    }
  }

  // --- 消した項目（墓標をまだ送っていないもの） ---
  for (const t of await dbAll(TOMB_STORE)) {
    if (!DATA_STORES.includes(t.store)) continue;
    if (sync.items[t.id] === DELETED_SIG) continue;
    rows.push({ user_id: userId, store: t.store, id: t.itemId, data: {}, deleted: true });
  }

  if (rows.length) {
    await _restUpsert('kaimono_items?on_conflict=user_id,store,id', rows);
    for (const r of rows) {
      sync.items[_key(r.store, r.id)] = r.deleted ? DELETED_SIG : _sig(r.data);
    }
  }
}

// ========== 同期のきっかけ ==========
window.addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync(300);
});

// ========== 画面 ==========
const $k = id => document.getElementById(id);

async function updateSyncUI() {
  const box = $k('sync-status');
  if (!box) return;
  const s = sbLoadSession();

  $k('sync-login-form').classList.toggle('hidden', !!s);
  $k('sync-logged-in').classList.toggle('hidden', !s);

  const snap = db ? await loadRollback() : null;
  const rb = $k('sync-rollback-btn');
  if (rb) {
    rb.classList.toggle('hidden', !snap);
    if (snap) rb.textContent = `取り込み前（商品${(snap.stores.products || []).length}件）に戻す`;
  }

  box.className = 'sync-status';
  if (!s) { box.textContent = 'ログインしていません（この端末だけに保存されます）'; return; }
  if (_syncing) { box.textContent = '同期中…'; return; }
  if (_lastSyncError) {
    box.textContent = `${s.email}／同期できていません（${_lastSyncError}）`;
    box.className = 'sync-status error';
    return;
  }
  const t = _loadSyncState().lastSyncedAt;
  box.textContent = `${s.email}／最終同期 ${t ? new Date(t).toLocaleString('ja-JP') : 'まだ'}`;
  box.className = 'sync-status ok';
}

async function submitSyncLogin(mode) {
  const email = $k('sync-email').value.trim();
  const password = $k('sync-password').value;
  const msg = $k('sync-login-msg');
  if (!email || !password) { msg.textContent = 'メールアドレスとパスワードを入力してください'; return; }
  if (mode === 'signup' && password.length < 8) {
    msg.textContent = 'パスワードは8文字以上にしてください'; return;
  }
  msg.textContent = mode === 'signup' ? '登録中…' : 'ログイン中…';
  try {
    if (mode === 'signup') {
      const r = await sbSignUp(email, password);
      if (r.needsConfirmation) {
        msg.textContent = '確認メールを送りました。リンクを開いてから「ログイン」してください。';
        return;
      }
    } else {
      await sbSignIn(email, password);
    }
    rememberLoginEmail(email);
    msg.textContent = '';
    $k('sync-password').value = '';
    await updateSyncUI();
    await syncNow({ toast: true });
  } catch (e) {
    msg.textContent = 'できませんでした：' + (e.message || e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const on = (id, fn) => { const el = $k(id); if (el) el.addEventListener('click', fn); };
  // ログインは click ではなく form の submit で受ける。
  // 端末のパスワード保存は submit を合図に「保存しますか？」を出すので、
  // click で処理してしまうと候補として登録されない。
  const form = $k('sync-login-form');
  if (form) form.addEventListener('submit', e => { e.preventDefault(); submitSyncLogin('login'); });
  on('sync-do-signup', () => submitSyncLogin('signup'));
  on('sync-now-btn', () => syncNow({ toast: true }));
  on('sync-rollback-btn', restoreRollback);
  on('sync-logout-btn', () => {
    if (!confirm('ログアウトします。ログインを共有している他のアプリもログアウトになります。\nこの端末のデータはそのまま残ります。よろしいですか？')) return;
    sbSignOut();
    updateSyncUI();
    showToast('ログアウトしました');
  });
  updateSyncUI();
});
