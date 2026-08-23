-- 儲存加入帳本當下的 Discord 顯示名稱，供分攤成員選單顯示。
-- 舊資料為 NULL，介面會退回顯示 user ID。
ALTER TABLE ledger_members ADD COLUMN display_name TEXT;
