# 買い物メモ

商品・価格・買い物リストを管理するPWA。
公開先は https://kazukitakeru-dotcom.github.io/kaimono/

## 構成

| ファイル | 中身 |
|---|---|
| `index.html` / `styles.css` | 画面 |
| `app.js` | 全ロジック（DB・描画・共有画像の生成・バックアップ） |
| `sync.js` | 複数端末同期（Supabase） |
| `sw.js` / `manifest.json` | PWA |
| `supabase.sql` | Supabase のテーブル定義。ダッシュボードの SQL Editor に貼って実行する |

## データ

IndexedDB `kaimono-db`（**v2**）。すべて `keyPath: 'id'`。

- `products` … 商品（画像は `imageDataUrl` に base64 の data URL のまま入る）
- `categories` / `storeNames` … カテゴリ・店舗
- `templates` … よく買う組み合わせ
- `prices` … 店ごとの価格記録
- `shoppingList` … いまの買い物リスト

同期のための内部ストア（バックアップの書き出し・復元の対象外）：

- `tombstones` … 消したものの墓標。`{ id: 'store:itemId', store, itemId, at }`
- `_sync` … 取り込み前の控え。商品画像込みだと localStorage に収まらないのでこちら

## 改修時の注意

- **ファイルを更新したら `sw.js` の `CACHE_NAME` を必ず上げる。**
  上げないと古いキャッシュが配られて変更が届かない。新しいファイルは `ASSETS` にも足す。
  ローカル検証中も `getRegistrations().unregister()` ＋ `caches.delete()` してからリロードしないと
  古いコードを掴む。
- **消すときは `dbDelete` / `dbClear` を通す。** この2つが墓標を自動で残す。
  `dbRawDelete` は同期の内部処理用で、墓標を残さない。

## 複数端末同期の設計

同じ Supabase プロジェクトに、わんにゃんメモリー／達人への道／IRON LOG／URUOI／
QUEST LIST と相乗り。ログインはメール＋パスワード。
未ログインなら同期処理は一切走らず、導入前と同じ挙動になる。

6ストアとも「IDを持つレコードの集合」で同じ形なので、`kaimono_items` 1テーブルに
`store` 列で区別して入れている。行単位の last-write-wins ＋ 墓標。

### このアプリで一番大事なのは墓標

買い物リストは「**買い終わったら消す**」作りになっている（完了・クリアで `dbDelete`）。
墓標が無いと、スマホでチェックして消した品物が、まだ持っているPCから押し戻されて
リストに復活する。導入前はここに何も無かった。

同じことが商品・テンプレート・カテゴリの削除にも当てはまるので、
墓標は `dbDelete` / `dbClear` の中で必ず残るようにしてある（呼ぶ側は今までどおりでよい）。

### その他の作り

- 取り込むか送るかの判定は**ハッシュ比較**。手元の姿がサーバーと合意済みのハッシュと違えば
  「未送信のローカル変更あり」と見て、取り込みをスキップして送信側に回す
- ハッシュは**キーを並べ替えてから**取る。Postgres の jsonb はキー順を保たないので、
  素の `JSON.stringify` で比べると中身が同じでも「変わった」と誤判定して送り直しが続く
- `updated_at` は**サーバーの `now()`**（トリガ）。端末の時計で入れると、時計がずれた端末の行が
  差分同期の網から永久に漏れる
- 取得位置は 5 秒だけ巻き戻して覚える（commit の順と `now()` のズレ対策）
- 1回の GET は 1000 件が上限なので `_restAll()` でページを送る
- 送信は 50 件ずつ。商品画像（base64）が入るので1回の送信量が大きくなりやすい
- クラウドの内容を反映する直前にこの端末のデータを丸ごと控える。
  設定 → 複数端末で同期 の「取り込み前に戻す」で1タップ戻せる

### 商品画像について

`imageDataUrl` は base64 のまま jsonb に入れている。Supabase Storage に分ける手もあるが、
`app.js` 全体が `imageDataUrl` をデータURL前提で読んでいて改修が重い割に、
実データ量が知れているので見送った。
**画像が数百枚まで増えたら初回同期が重くなる**ので、そのときは保存時に縮小するのが先。

### テーブルを足すとき

複数アプリの相乗り前提なので、毎回
**「`authenticated` に grant ／ `anon` から revoke ／ RLS＋ポリシー」を明示する**こと。
実例は `supabase.sql`。
