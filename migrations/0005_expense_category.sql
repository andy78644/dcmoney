-- 支出分類。自由文字而非固定清單：autocomplete 會回填該帳本用過的分類，
-- 讓分類隨使用長出來，不必事先設定，也不影響分帳計算。
ALTER TABLE transactions ADD COLUMN category TEXT;

CREATE INDEX transactions_category_index
  ON transactions (ledger_id, category);
