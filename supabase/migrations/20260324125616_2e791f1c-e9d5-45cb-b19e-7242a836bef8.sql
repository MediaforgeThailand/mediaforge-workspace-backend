-- 1. Add cashback_percent to subscription_plans
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS cashback_percent numeric NOT NULL DEFAULT 0;

-- 2. Create flow_user_reviews table
CREATE TABLE IF NOT EXISTS flow_user_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT,
  cashback_credits INTEGER NOT NULL DEFAULT 0,
  cashback_granted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(flow_run_id, user_id)
);

-- 3. Add validation trigger for rating (1-5)
CREATE OR REPLACE FUNCTION validate_review_rating()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.rating < 1 OR NEW.rating > 5 THEN
    RAISE EXCEPTION 'Rating must be between 1 and 5';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_review_rating
  BEFORE INSERT OR UPDATE ON flow_user_reviews
  FOR EACH ROW EXECUTE FUNCTION validate_review_rating();

-- 4. Enable RLS
ALTER TABLE flow_user_reviews ENABLE ROW LEVEL SECURITY;

-- 5. RLS policies
CREATE POLICY "Users can insert own reviews"
  ON flow_user_reviews FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own reviews"
  ON flow_user_reviews FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Anyone can read reviews of published flows"
  ON flow_user_reviews FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM flows WHERE flows.id = flow_user_reviews.flow_id AND flows.status = 'published'
  ));