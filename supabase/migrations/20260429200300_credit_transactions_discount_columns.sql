-- Phase 4a: track credit-discount visibly in the ledger.
-- Each row now records both the price the user "saw" (amount, signed: negative on usage)
-- and the actual deducted amount (effective_amount, also signed). discount_percent
-- captures the percent applied on this single transaction (0 if no plan discount).
alter table public.credit_transactions
  add column if not exists effective_amount int,
  add column if not exists discount_percent int default 0;

alter table public.team_credit_transactions
  add column if not exists effective_amount int,
  add column if not exists discount_percent int default 0;

comment on column public.credit_transactions.effective_amount is
  'Credits actually deducted after applying credit_discount_percent. Negative on usage rows.';
comment on column public.credit_transactions.discount_percent is
  'Discount percent applied to this transaction (0 if no plan discount).';
comment on column public.team_credit_transactions.effective_amount is
  'Credits actually deducted from team pool after applying credit_discount_percent. Negative on usage rows.';
comment on column public.team_credit_transactions.discount_percent is
  'Discount percent applied (typically 20 for Team plan).';
