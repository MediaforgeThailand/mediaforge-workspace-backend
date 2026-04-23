CREATE OR REPLACE FUNCTION public.match_flows(
  query_embedding extensions.vector,
  match_threshold double precision DEFAULT 0.5,
  match_count integer DEFAULT 20,
  search_query text DEFAULT ''::text,
  match_offset integer DEFAULT 0
)
 RETURNS TABLE(id uuid, name text, description text, category text, thumbnail_url text, tags text[], keywords text[], base_cost integer, selling_price integer, is_official boolean, user_id uuid, status text, similarity double precision, keyword_score double precision, combined_score double precision)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_search text := lower(trim(search_query));
  v_has_query boolean := length(v_search) > 0;
  v_has_embedding boolean := query_embedding IS NOT NULL;
BEGIN
  RETURN QUERY
  SELECT
    f.id,
    f.name,
    f.description,
    f.category,
    f.thumbnail_url,
    f.tags,
    f.keywords,
    f.base_cost,
    f.selling_price,
    f.is_official,
    f.user_id,
    f.status,
    CASE
      WHEN v_has_embedding AND f.embedding IS NOT NULL
      THEN (1 - (f.embedding <=> query_embedding))::float
      ELSE 0.0
    END AS similarity,
    CASE
      WHEN v_has_query THEN (
        CASE WHEN lower(f.name) ILIKE '%' || v_search || '%' THEN 0.4 ELSE 0.0 END +
        CASE WHEN lower(f.description) ILIKE '%' || v_search || '%' THEN 0.2 ELSE 0.0 END +
        CASE WHEN v_search = ANY(f.keywords) THEN 0.3 ELSE 0.0 END +
        CASE WHEN EXISTS (
          SELECT 1 FROM unnest(f.keywords) k WHERE k ILIKE '%' || v_search || '%'
        ) THEN 0.1 ELSE 0.0 END
      )::float
      ELSE 0.0
    END AS keyword_score,
    (
      CASE
        WHEN v_has_embedding AND f.embedding IS NOT NULL
        THEN (1 - (f.embedding <=> query_embedding))::float * 0.75
        ELSE 0.0
      END +
      CASE
        WHEN v_has_query THEN (
          CASE WHEN lower(f.name) ILIKE '%' || v_search || '%' THEN 0.4 ELSE 0.0 END +
          CASE WHEN lower(f.description) ILIKE '%' || v_search || '%' THEN 0.2 ELSE 0.0 END +
          CASE WHEN v_search = ANY(f.keywords) THEN 0.3 ELSE 0.0 END +
          CASE WHEN EXISTS (
            SELECT 1 FROM unnest(f.keywords) k WHERE k ILIKE '%' || v_search || '%'
          ) THEN 0.1 ELSE 0.0 END
        )::float * 0.25
        ELSE 0.0
      END
    )::float AS combined_score
  FROM public.flows f
  WHERE f.status = 'published'
    AND (
      (v_has_embedding AND f.embedding IS NOT NULL AND (1 - (f.embedding <=> query_embedding)) >= match_threshold)
      OR
      (v_has_query AND (
        lower(f.name) ILIKE '%' || v_search || '%'
        OR lower(f.description) ILIKE '%' || v_search || '%'
        OR v_search = ANY(f.keywords)
        OR EXISTS (SELECT 1 FROM unnest(f.keywords) k WHERE k ILIKE '%' || v_search || '%')
      ))
    )
  ORDER BY combined_score DESC
  LIMIT match_count
  OFFSET match_offset;
END;
$function$;
