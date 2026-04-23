
-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- Make vector type resolvable without schema-qualifying every reference
SET search_path TO public, extensions;

-- 2. Add embedding column to flows table
ALTER TABLE public.flows
ADD COLUMN IF NOT EXISTS embedding vector(768);

-- 3. Create IVFFlat index for fast cosine similarity search
-- Using ivfflat with cosine distance operator
CREATE INDEX IF NOT EXISTS idx_flows_embedding
ON public.flows
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 50);

-- 4. Create hybrid search function
CREATE OR REPLACE FUNCTION public.match_flows(
  query_embedding vector(768),
  match_threshold float DEFAULT 0.5,
  match_count int DEFAULT 20,
  search_query text DEFAULT ''
)
RETURNS TABLE (
  id uuid,
  name text,
  description text,
  category text,
  thumbnail_url text,
  tags text[],
  keywords text[],
  base_cost int,
  selling_price int,
  is_official boolean,
  user_id uuid,
  status text,
  similarity float,
  keyword_score float,
  combined_score float
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
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
    -- Vector similarity score (1 - cosine distance), 0 if no embedding
    CASE
      WHEN v_has_embedding AND f.embedding IS NOT NULL
      THEN (1 - (f.embedding <=> query_embedding))::float
      ELSE 0.0
    END AS similarity,
    -- Keyword/text match score
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
    -- Combined score: weighted blend
    (
      CASE
        WHEN v_has_embedding AND f.embedding IS NOT NULL
        THEN (1 - (f.embedding <=> query_embedding))::float * 0.6
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
        )::float * 0.4
        ELSE 0.0
      END
    )::float AS combined_score
  FROM public.flows f
  WHERE f.status = 'published'
    AND (
      -- If we have an embedding, filter by threshold
      (v_has_embedding AND f.embedding IS NOT NULL AND (1 - (f.embedding <=> query_embedding)) >= match_threshold)
      OR
      -- If we have a text query, include keyword matches
      (v_has_query AND (
        lower(f.name) ILIKE '%' || v_search || '%'
        OR lower(f.description) ILIKE '%' || v_search || '%'
        OR v_search = ANY(f.keywords)
        OR EXISTS (SELECT 1 FROM unnest(f.keywords) k WHERE k ILIKE '%' || v_search || '%')
      ))
    )
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$$;
