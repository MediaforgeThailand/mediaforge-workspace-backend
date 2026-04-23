-- Allow authenticated users to read flow_nodes of published flows
CREATE POLICY "Anyone authenticated can view nodes of published flows"
ON public.flow_nodes
FOR SELECT
USING (
  auth.uid() IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.flows
    WHERE flows.id = flow_nodes.flow_id
    AND flows.status = 'published'
  )
);