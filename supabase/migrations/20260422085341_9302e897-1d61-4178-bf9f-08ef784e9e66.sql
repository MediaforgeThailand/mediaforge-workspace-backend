-- Allow public read access to flows that belong to at least one published bundle.
-- This is required so users opening a published bundle can run flows that are
-- approved but not individually published.
DROP POLICY IF EXISTS "Anyone can view flows in published bundles" ON public.flows;
CREATE POLICY "Anyone can view flows in published bundles"
ON public.flows
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.bundle_flows bf
    JOIN public.bundles b ON b.id = bf.bundle_id
    WHERE bf.flow_id = flows.id
      AND b.status = 'published'
  )
);
