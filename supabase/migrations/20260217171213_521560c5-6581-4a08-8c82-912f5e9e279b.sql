
-- Spaces table
CREATE TABLE public.spaces (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL DEFAULT 'Untitled Space',
  description TEXT,
  thumbnail_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.spaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own spaces" ON public.spaces FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own spaces" ON public.spaces FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own spaces" ON public.spaces FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own spaces" ON public.spaces FOR DELETE USING (auth.uid() = user_id);

CREATE TRIGGER update_spaces_updated_at BEFORE UPDATE ON public.spaces
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Space nodes table
CREATE TABLE public.space_nodes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  space_id UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- 'image-generator', 'video-generator', 'assistant', 'image-editor', 'creation'
  position_x DOUBLE PRECISION NOT NULL DEFAULT 0,
  position_y DOUBLE PRECISION NOT NULL DEFAULT 0,
  width DOUBLE PRECISION,
  height DOUBLE PRECISION,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.space_nodes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own space nodes" ON public.space_nodes FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.spaces WHERE spaces.id = space_nodes.space_id AND spaces.user_id = auth.uid()));
CREATE POLICY "Users can create own space nodes" ON public.space_nodes FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.spaces WHERE spaces.id = space_nodes.space_id AND spaces.user_id = auth.uid()));
CREATE POLICY "Users can update own space nodes" ON public.space_nodes FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.spaces WHERE spaces.id = space_nodes.space_id AND spaces.user_id = auth.uid()));
CREATE POLICY "Users can delete own space nodes" ON public.space_nodes FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.spaces WHERE spaces.id = space_nodes.space_id AND spaces.user_id = auth.uid()));

CREATE TRIGGER update_space_nodes_updated_at BEFORE UPDATE ON public.space_nodes
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Space edges table
CREATE TABLE public.space_edges (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  space_id UUID NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,
  source_node_id UUID NOT NULL REFERENCES public.space_nodes(id) ON DELETE CASCADE,
  target_node_id UUID NOT NULL REFERENCES public.space_nodes(id) ON DELETE CASCADE,
  source_handle TEXT,
  target_handle TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

ALTER TABLE public.space_edges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own space edges" ON public.space_edges FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.spaces WHERE spaces.id = space_edges.space_id AND spaces.user_id = auth.uid()));
CREATE POLICY "Users can create own space edges" ON public.space_edges FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM public.spaces WHERE spaces.id = space_edges.space_id AND spaces.user_id = auth.uid()));
CREATE POLICY "Users can update own space edges" ON public.space_edges FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.spaces WHERE spaces.id = space_edges.space_id AND spaces.user_id = auth.uid()));
CREATE POLICY "Users can delete own space edges" ON public.space_edges FOR DELETE
  USING (EXISTS (SELECT 1 FROM public.spaces WHERE spaces.id = space_edges.space_id AND spaces.user_id = auth.uid()));

-- Index for performance
CREATE INDEX idx_space_nodes_space_id ON public.space_nodes(space_id);
CREATE INDEX idx_space_edges_space_id ON public.space_edges(space_id);
CREATE INDEX idx_spaces_user_id ON public.spaces(user_id);
