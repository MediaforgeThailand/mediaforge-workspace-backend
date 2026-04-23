-- Bundles table: a "Creative Kit" containing multiple flows
CREATE TABLE IF NOT EXISTS public.bundles (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL DEFAULT 'Untitled Bundle',
  description TEXT,
  thumbnail_url TEXT,
  thumbnail_type TEXT DEFAULT 'image' CHECK (thumbnail_type IN ('image','video')),
  keywords TEXT[] DEFAULT ARRAY[]::TEXT[],
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  categories TEXT[] DEFAULT ARRAY[]::TEXT[],
  industry_tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  use_case_tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  format_tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','in_review','published','rejected','archived')),
  is_official BOOLEAN NOT NULL DEFAULT false,
  embedding extensions.vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bundles_user_id ON public.bundles(user_id);
CREATE INDEX IF NOT EXISTS idx_bundles_status ON public.bundles(status);

ALTER TABLE public.bundles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage their bundles"
  ON public.bundles FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Public can view published bundles"
  ON public.bundles FOR SELECT
  USING (status = 'published');

CREATE POLICY "Admins manage all bundles"
  ON public.bundles FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_bundles_updated_at
  BEFORE UPDATE ON public.bundles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Junction: bundle_flows (reference shared, ordered)
CREATE TABLE IF NOT EXISTS public.bundle_flows (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bundle_id UUID NOT NULL REFERENCES public.bundles(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bundle_id, flow_id)
);

CREATE INDEX IF NOT EXISTS idx_bundle_flows_bundle_id ON public.bundle_flows(bundle_id);
CREATE INDEX IF NOT EXISTS idx_bundle_flows_flow_id ON public.bundle_flows(flow_id);

ALTER TABLE public.bundle_flows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners manage their bundle flows"
  ON public.bundle_flows FOR ALL
  USING (EXISTS (SELECT 1 FROM public.bundles b WHERE b.id = bundle_id AND b.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.bundles b WHERE b.id = bundle_id AND b.user_id = auth.uid()));

CREATE POLICY "Public can view flows of published bundles"
  ON public.bundle_flows FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.bundles b WHERE b.id = bundle_id AND b.status = 'published'));

CREATE POLICY "Admins manage all bundle flows"
  ON public.bundle_flows FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Hybrid search: bundle metadata + inner flows' keywords/descriptions
CREATE OR REPLACE FUNCTION public.search_bundles_hybrid(
  search_query TEXT,
  match_limit INT DEFAULT 30
)
RETURNS TABLE (
  id UUID,
  name TEXT,
  description TEXT,
  thumbnail_url TEXT,
  thumbnail_type TEXT,
  user_id UUID,
  is_official BOOLEAN,
  keywords TEXT[],
  tags TEXT[],
  categories TEXT[],
  flow_count BIGINT,
  match_score REAL
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  q TEXT := lower(coalesce(search_query, ''));
BEGIN
  RETURN QUERY
  WITH inner_flow_text AS (
    SELECT
      bf.bundle_id,
      string_agg(
        coalesce(f.name,'') || ' ' || coalesce(f.description,'') || ' ' ||
        coalesce(array_to_string(f.keywords,' '),'') || ' ' ||
        coalesce(array_to_string(f.tags,' '),''),
        ' '
      ) AS combined
    FROM public.bundle_flows bf
    JOIN public.flows f ON f.id = bf.flow_id
    GROUP BY bf.bundle_id
  ),
  scored AS (
    SELECT
      b.id, b.name, b.description, b.thumbnail_url, b.thumbnail_type,
      b.user_id, b.is_official, b.keywords, b.tags, b.categories,
      (SELECT count(*) FROM public.bundle_flows bf2 WHERE bf2.bundle_id = b.id) AS flow_count,
      (
        CASE WHEN q = '' THEN 0.5
             WHEN lower(b.name) LIKE '%'||q||'%' THEN 1.0
             WHEN lower(coalesce(b.description,'')) LIKE '%'||q||'%' THEN 0.8
             WHEN EXISTS (SELECT 1 FROM unnest(b.keywords) k WHERE lower(k) LIKE '%'||q||'%') THEN 0.7
             WHEN EXISTS (SELECT 1 FROM unnest(b.tags) t WHERE lower(t) LIKE '%'||q||'%') THEN 0.6
             WHEN lower(coalesce(ift.combined,'')) LIKE '%'||q||'%' THEN 0.5
             ELSE 0.0
        END
      )::REAL AS match_score
    FROM public.bundles b
    LEFT JOIN inner_flow_text ift ON ift.bundle_id = b.id
    WHERE b.status = 'published'
  )
  SELECT s.id, s.name, s.description, s.thumbnail_url, s.thumbnail_type,
         s.user_id, s.is_official, s.keywords, s.tags, s.categories,
         s.flow_count, s.match_score
  FROM scored s
  WHERE s.match_score > 0
  ORDER BY s.match_score DESC, s.flow_count DESC
  LIMIT match_limit;
END;
$$;