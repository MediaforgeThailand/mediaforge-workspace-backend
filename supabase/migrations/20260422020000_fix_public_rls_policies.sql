-- Fix: Allow anonymous users to view published flows and public profiles
-- The original policy required auth.uid() IS NOT NULL, blocking non-logged-in users
-- from seeing the flow marketplace on the home page.

-- Flows: anyone can view published
DROP POLICY IF EXISTS "Anyone authenticated can view published flows" ON flows;
DROP POLICY IF EXISTS "Anyone can view published flows" ON flows;
CREATE POLICY "Anyone can view published flows" ON flows
  FOR SELECT USING (status = 'published');

-- Flows: anyone can view flows that are part of published bundles
DROP POLICY IF EXISTS "Anyone can view flows in published bundles" ON flows;
CREATE POLICY "Anyone can view flows in published bundles" ON flows
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM bundle_flows bf
      JOIN bundles b ON b.id = bf.bundle_id
      WHERE bf.flow_id = flows.id AND b.status = 'published'
    )
  );

-- Profiles: anyone can read (needed to show creator names on flow cards)
DROP POLICY IF EXISTS "Anyone can view public profile fields" ON profiles;
CREATE POLICY "Anyone can view public profile fields" ON profiles
  FOR SELECT USING (true);
