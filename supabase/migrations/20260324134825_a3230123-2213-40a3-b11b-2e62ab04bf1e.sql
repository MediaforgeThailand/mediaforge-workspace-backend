-- Allow anyone (including anonymous) to view active subscription plans
DROP POLICY IF EXISTS "Authenticated users can view active plans" ON subscription_plans;
CREATE POLICY "Anyone can view active plans" ON subscription_plans FOR SELECT USING (is_active = true);

-- Allow anyone to view active topup packages
DROP POLICY IF EXISTS "Authenticated can view active topup packages" ON topup_packages;
CREATE POLICY "Anyone can view active topup packages" ON topup_packages FOR SELECT USING (is_active = true);

-- Allow anyone to view active credit packages
DROP POLICY IF EXISTS "Authenticated users can view active packages" ON credit_packages;
CREATE POLICY "Anyone can view active credit packages" ON credit_packages FOR SELECT USING (is_active = true);