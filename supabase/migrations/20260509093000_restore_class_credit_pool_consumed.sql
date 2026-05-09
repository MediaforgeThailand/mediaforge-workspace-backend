-- Production education enrollments rely on classes.credit_pool_consumed when
-- creating or topping up class-scoped student spaces. Some live databases were
-- missing the column even though later RPCs reference it.

BEGIN;

ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS credit_pool_consumed INT NOT NULL DEFAULT 0;

ALTER TABLE public.classes
  DROP CONSTRAINT IF EXISTS classes_credit_pool_consumed_check;

ALTER TABLE public.classes
  ADD CONSTRAINT classes_credit_pool_consumed_check
  CHECK (credit_pool_consumed >= 0);

COMMIT;
