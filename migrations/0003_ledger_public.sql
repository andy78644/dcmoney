-- 公開帳本：記帳、還款、修改與刪除都會在頻道公開announce，
-- 讓所有成員知道誰動了帳，而不必自己去查。預設關閉。
ALTER TABLE ledgers ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0
  CHECK (is_public IN (0, 1));
