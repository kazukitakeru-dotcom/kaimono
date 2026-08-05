-- ============================================================================
-- 買い物メモ — Supabase テーブル定義
-- わんにゃんメモリー／達人への道／IRON LOG／URUOI／QUEST LIST と
-- 同じプロジェクトに相乗りするため、
-- 「authenticated に grant / anon から revoke / RLS＋ポリシー」を毎回明示する。
-- Supabase ダッシュボード → SQL Editor に貼って実行する。
-- 何度実行しても壊れないように書いてある。
--
-- ※ SQL Editor は必ずタブの「＋」で新しいクエリを作ってから貼ること
--   （既存の「無題のクエリ」を上書きしてしまわないように）。
-- ============================================================================

-- ── 0) updated_at をサーバー時刻で入れるための共通トリガ関数 ──
-- 端末の時計で updated_at を入れると、時計がずれた端末の行が
-- 「前回より新しい行だけ取る」差分同期の網から永久に漏れる。
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── 1) 商品・カテゴリ・店舗・テンプレート・価格・買い物リスト ──
-- 6つとも「IDを持つレコードの集合」でまったく同じ形なので、
-- store 列で区別して1つのテーブルにまとめている。
--
-- 注意: 商品画像は data の中に base64 の data URL のまま入る。
-- Storage に分ける手もあるが、app.js 全体が imageDataUrl を
-- データURL前提で読んでいて改修が重い割に、実データ量が知れているので見送り。
create table if not exists public.kaimono_items (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  store      text        not null,   -- 'products' | 'categories' | 'storeNames'
                                     -- | 'templates' | 'prices' | 'shoppingList'
  id         text        not null,   -- アプリが作るID
  data       jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, store, id)
);

create index if not exists kaimono_items_user_updated_idx
  on public.kaimono_items (user_id, updated_at asc);

drop trigger if exists kaimono_items_touch on public.kaimono_items;
create trigger kaimono_items_touch before insert or update on public.kaimono_items
  for each row execute function public.set_updated_at();

-- ── RLS ──
alter table public.kaimono_items enable row level security;

drop policy if exists kaimono_items_own on public.kaimono_items;

create policy kaimono_items_own on public.kaimono_items
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 権限（anon は完全に締め出す。自動設定に頼らず明示する） ──
revoke all on public.kaimono_items from anon;

grant select, insert, update, delete on public.kaimono_items to authenticated;

-- ── 確認用（anon で叩くと permission denied になるのが正しい） ──
-- select * from public.kaimono_items limit 1;
