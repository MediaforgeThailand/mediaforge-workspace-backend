
CREATE OR REPLACE FUNCTION public.search_bundles_hybrid(
  search_query TEXT,
  match_limit INTEGER DEFAULT 30
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
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

GRANT EXECUTE ON FUNCTION public.search_bundles_hybrid(TEXT, INTEGER) TO anon, authenticated;
