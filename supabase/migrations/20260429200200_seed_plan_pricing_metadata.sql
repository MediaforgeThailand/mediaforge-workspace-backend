-- Phase 1c: seed pricing metadata + Stripe ids on the 4 active workspace plans.
-- Pricing rules (per the spec):
--   * annual_price_thb = round(price_thb * 12 * 0.8)
--   * annual_credits   = upfront_credits * 12
--   * credit_discount_percent: Starter 0, Creator 0, Pro 10, Team 20
--   * generator_quota = 5 across the board
--   * Pro uses is_featured=true (drives "BEST VALUE" ribbon)
--   * Team is contact-sales / metered → no annual / no Stripe price ids
-- Stripe ids are LIVE-mode (account acct_1T0BBi97qpzc2aQt). See stripe-setup-notes.md.

-- Starter
update public.subscription_plans
   set annual_price_thb = round(price_thb * 12 * 0.8),
       annual_credits = upfront_credits * 12,
       credit_discount_percent = 0,
       generator_quota = 5,
       generator_quota_label = '5 generator engines',
       is_featured = false,
       stripe_product_id = 'prod_UQKkTVDEQCGJpp',
       stripe_price_id_monthly = 'price_1TRU4m97qpzc2aQt5KAb4LLG',
       stripe_price_id_annual  = 'price_1TRU4o97qpzc2aQtJMwkbFuB',
       stripe_price_id = 'price_1TRU4m97qpzc2aQt5KAb4LLG'
 where name = 'Starter' and target = 'user' and is_active = true;

-- Creator
update public.subscription_plans
   set annual_price_thb = round(price_thb * 12 * 0.8),
       annual_credits = upfront_credits * 12,
       credit_discount_percent = 0,
       generator_quota = 5,
       generator_quota_label = '5 generator engines',
       is_featured = false,
       stripe_product_id = 'prod_UQKkrZbBIPvJX1',
       stripe_price_id_monthly = 'price_1TRU4q97qpzc2aQtHzFhOOAb',
       stripe_price_id_annual  = 'price_1TRU4t97qpzc2aQtt2KBhGAQ',
       stripe_price_id = 'price_1TRU4q97qpzc2aQtHzFhOOAb'
 where name = 'Creator' and target = 'user' and is_active = true;

-- Pro (featured + 10% credit discount)
update public.subscription_plans
   set annual_price_thb = round(price_thb * 12 * 0.8),
       annual_credits = upfront_credits * 12,
       credit_discount_percent = 10,
       generator_quota = 5,
       generator_quota_label = '5 generator engines',
       is_featured = true,
       stripe_product_id = 'prod_UQKkxl5IxUfbcs',
       stripe_price_id_monthly = 'price_1TRU4v97qpzc2aQt5oRhoMWE',
       stripe_price_id_annual  = 'price_1TRU4y97qpzc2aQtQ7nwZBdl',
       stripe_price_id = 'price_1TRU4v97qpzc2aQt5oRhoMWE'
 where name = 'Pro' and target = 'user' and is_active = true;

-- Team (metered, contact-sales — 20% credit discount)
update public.subscription_plans
   set annual_price_thb = null,
       annual_credits = null,
       credit_discount_percent = 20,
       generator_quota = 5,
       generator_quota_label = '5 generators / seat',
       is_featured = false,
       stripe_product_id = 'prod_UQKkouRF8Xjh9F',
       stripe_price_id_monthly = null,
       stripe_price_id_annual  = null,
       stripe_price_id = null
 where name = 'Team' and target = 'team' and is_active = true;
