UPDATE public.subscription_plans SET upfront_credits=67500, discount_official=0, discount_community=0 WHERE id='72315cb8-b3b0-4889-91d5-c7dc5a3de61d';
UPDATE public.subscription_plans SET upfront_credits=161250, discount_official=5, discount_community=0 WHERE id='417b8143-237b-4fa9-8be7-08effc64375d';
UPDATE public.subscription_plans SET upfront_credits=248750, discount_official=10, discount_community=0 WHERE id='e5971003-150e-4140-a5c3-5dfb4c61595e';
UPDATE public.subscription_plans SET upfront_credits=373750, discount_official=20, discount_community=0 WHERE id='22965566-ffec-4baf-ab72-9fbef568551b';

UPDATE public.subscription_plans SET upfront_credits=648000, price_thb=5184, discount_official=0, discount_community=0 WHERE id='70eb0e7e-7d80-4129-9d08-713525876406';
UPDATE public.subscription_plans SET upfront_credits=1548000, price_thb=12384, discount_official=5, discount_community=0 WHERE id='a94c01dd-fc54-4e9a-a713-d7999a91311f';
UPDATE public.subscription_plans SET upfront_credits=2388000, price_thb=19104, discount_official=10, discount_community=0 WHERE id='8f6040bb-b02c-4b25-9995-ee9a91384532';
UPDATE public.subscription_plans SET upfront_credits=3588000, price_thb=28704, discount_official=20, discount_community=0 WHERE id='c132b590-370d-46e4-beee-b51d3d2312c1';

INSERT INTO public.subscription_plans (id, name, target, billing_cycle, price_thb, upfront_credits, flow_quota, discount_official, discount_community, is_active, sort_order, stripe_price_id, stripe_product_id, cashback_percent) VALUES
 ('9b660b57-d52b-42dc-8891-4853e164622f','Starter','user','quarterly',1458,182250,NULL,0,0,true,9,'price_1TON8G97qpzc2aQtcCVOuxEX','prod_UN7NLgYAGSZtmQ',0),
 ('97628d1f-2988-4ee9-8e5d-f02996a09a74','Starter','user','semiannual',2754,344250,NULL,0,0,true,10,'price_1TON8H97qpzc2aQtYQJvttkf','prod_UN7N3adog2PL5Z',0),
 ('34746584-9ab2-4337-a875-498bc3952b3f','Growth','user','quarterly',3483,435375,NULL,5,0,true,11,'price_1TON8I97qpzc2aQtG3nkqOyP','prod_UN7NLAesHWr9w4',0),
 ('aa02324a-7f7a-4ece-bbf9-c85dd135ffeb','Growth','user','semiannual',6579,822375,NULL,5,0,true,12,'price_1TON8J97qpzc2aQtp9lYwDkQ','prod_UN7Nkwo2lTCU08',0),
 ('3549056e-12a2-4fe9-89b1-9d8e26cbad2f','Professional','user','quarterly',5373,671625,NULL,10,0,true,13,'price_1TON8L97qpzc2aQtK77Ez6Tz','prod_UN7NCfMZvjmFVU',0),
 ('97bb84a4-f3d9-4701-883a-59c3f1d655e9','Professional','user','semiannual',10149,1268625,NULL,10,0,true,14,'price_1TON8M97qpzc2aQtY1QyMYo3','prod_UN7NzHufDWLr5I',0),
 ('00c1b9d2-b22a-491c-b559-86a072a905e2','Enterprise','user','quarterly',8073,1009125,NULL,20,0,true,15,'price_1TON8N97qpzc2aQtDX0wxGjE','prod_UN7NgTgtq5zy2i',0),
 ('b168566c-fe16-4ccb-b18a-f72fe58f6181','Enterprise','user','semiannual',15249,1906125,NULL,20,0,true,16,'price_1TON8N97qpzc2aQtLnIfSHfk','prod_UN7NMJl0rhYyHA',0)
ON CONFLICT (id) DO UPDATE SET
  upfront_credits=EXCLUDED.upfront_credits,
  price_thb=EXCLUDED.price_thb,
  discount_official=EXCLUDED.discount_official,
  discount_community=EXCLUDED.discount_community,
  stripe_price_id=EXCLUDED.stripe_price_id,
  stripe_product_id=EXCLUDED.stripe_product_id,
  is_active=EXCLUDED.is_active;

UPDATE public.topup_packages SET credits=6250  WHERE id='a0c99069-0727-4d8a-9f37-ea94899e8354';
UPDATE public.topup_packages SET credits=15625 WHERE id='7b77c102-fc79-46f8-80eb-03ee206a242d';
UPDATE public.topup_packages SET credits=31250 WHERE id='bc959c8b-9507-4d1a-89ad-b4babf05643e';
UPDATE public.topup_packages SET credits=62500 WHERE id='f34e33db-f76b-4781-b620-b6dc770b6800';
UPDATE public.topup_packages SET credits=156250 WHERE id='ec55a802-b082-464f-ba59-058e436f34f8';

INSERT INTO public.topup_packages (id, name, credits, price_thb, stripe_price_id, stripe_product_id, is_active, sort_order, badge_label, bonus_percent, is_promo, one_time_per_user, original_credits) VALUES
 ('254367e9-c837-4824-95b9-39054d41d746','Welcome Promo',12250,49,'price_1TOGtA97qpzc2aQt2cf16bby',NULL,true,0,'WELCOME OFFER',200,true,true,4083)
ON CONFLICT (id) DO UPDATE SET
  credits=EXCLUDED.credits,
  price_thb=EXCLUDED.price_thb,
  stripe_price_id=EXCLUDED.stripe_price_id,
  is_active=EXCLUDED.is_active,
  badge_label=EXCLUDED.badge_label,
  bonus_percent=EXCLUDED.bonus_percent,
  is_promo=EXCLUDED.is_promo,
  one_time_per_user=EXCLUDED.one_time_per_user,
  original_credits=EXCLUDED.original_credits;