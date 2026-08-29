-- 管理者。原本只有單一建立者能管理成員與設定，一旦他退出 Discord 伺服器，
-- 帳本就沒有任何人能再管理。改為可有多位管理者，並允許轉移建立者身分。
ALTER TABLE ledger_members ADD COLUMN is_manager INTEGER NOT NULL DEFAULT 0
  CHECK (is_manager IN (0, 1));

-- 既有帳本的建立者一律視為管理者。
UPDATE ledger_members
   SET is_manager = 1
 WHERE EXISTS (
   SELECT 1 FROM ledgers
    WHERE ledgers.id = ledger_members.ledger_id
      AND ledgers.owner_user_id = ledger_members.user_id
 );
