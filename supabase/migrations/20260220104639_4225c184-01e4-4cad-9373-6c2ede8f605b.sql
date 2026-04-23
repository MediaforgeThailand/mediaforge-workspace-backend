
-- =============================================
-- Flow Studio Database Schema
-- =============================================

-- 1. Flows — master record for each automation flow
CREATE TABLE public.flows (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  name text NOT NULL DEFAULT 'Untitled Flow',
  description text,
  category text NOT NULL DEFAULT 'general',
  status text NOT NULL DEFAULT 'draft',  -- draft | testing | published | archived
  current_version integer NOT NULL DEFAULT 1,
  thumbnail_url text,
  tags text[] DEFAULT '{}'::text[],
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- 2. Flow Versions — immutable snapshots of a flow
CREATE TABLE public.flow_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,  -- full serialized nodes+edges
  change_note text,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version)
);

-- 3. Flow Nodes — individual steps in the current working version
CREATE TABLE public.flow_nodes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  node_type text NOT NULL,  -- e.g. image_gen, video_gen, text, upscale, tts
  label text NOT NULL DEFAULT 'Untitled Node',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  position_x double precision NOT NULL DEFAULT 0,
  position_y double precision NOT NULL DEFAULT 0,
  width double precision,
  height double precision,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- 4. Flow Runs — production execution log
CREATE TABLE public.flow_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  outputs jsonb,
  error_message text,
  credits_used integer NOT NULL DEFAULT 0,
  duration_ms integer,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone
);

-- 5. Flow Test Runs — sandbox executions during development
CREATE TABLE public.flow_test_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  node_id uuid REFERENCES public.flow_nodes(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',  -- pending | running | completed | failed
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  outputs jsonb,
  error_message text,
  duration_ms integer,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- =============================================
-- Enable RLS on all tables
-- =============================================
ALTER TABLE public.flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flow_test_runs ENABLE ROW LEVEL SECURITY;

-- =============================================
-- RLS Policies — flows
-- =============================================
CREATE POLICY "Users can view own flows" ON public.flows
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own flows" ON public.flows
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own flows" ON public.flows
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own flows" ON public.flows
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all flows" ON public.flows
  FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role));

-- =============================================
-- RLS Policies — flow_versions (via parent flow ownership)
-- =============================================
CREATE POLICY "Users can view own flow versions" ON public.flow_versions
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.flows WHERE flows.id = flow_versions.flow_id AND flows.user_id = auth.uid()
  ));

CREATE POLICY "Users can create own flow versions" ON public.flow_versions
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.flows WHERE flows.id = flow_versions.flow_id AND flows.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete own flow versions" ON public.flow_versions
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM public.flows WHERE flows.id = flow_versions.flow_id AND flows.user_id = auth.uid()
  ));

-- =============================================
-- RLS Policies — flow_nodes (via parent flow ownership)
-- =============================================
CREATE POLICY "Users can view own flow nodes" ON public.flow_nodes
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.flows WHERE flows.id = flow_nodes.flow_id AND flows.user_id = auth.uid()
  ));

CREATE POLICY "Users can create own flow nodes" ON public.flow_nodes
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM public.flows WHERE flows.id = flow_nodes.flow_id AND flows.user_id = auth.uid()
  ));

CREATE POLICY "Users can update own flow nodes" ON public.flow_nodes
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM public.flows WHERE flows.id = flow_nodes.flow_id AND flows.user_id = auth.uid()
  ));

CREATE POLICY "Users can delete own flow nodes" ON public.flow_nodes
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM public.flows WHERE flows.id = flow_nodes.flow_id AND flows.user_id = auth.uid()
  ));

-- =============================================
-- RLS Policies — flow_runs
-- =============================================
CREATE POLICY "Users can view own flow runs" ON public.flow_runs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own flow runs" ON public.flow_runs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own flow runs" ON public.flow_runs
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all flow runs" ON public.flow_runs
  FOR SELECT USING (has_role(auth.uid(), 'admin'::app_role));

-- =============================================
-- RLS Policies — flow_test_runs
-- =============================================
CREATE POLICY "Users can view own test runs" ON public.flow_test_runs
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can create own test runs" ON public.flow_test_runs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own test runs" ON public.flow_test_runs
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own test runs" ON public.flow_test_runs
  FOR DELETE USING (auth.uid() = user_id);

-- =============================================
-- Triggers — auto-update updated_at
-- =============================================
CREATE TRIGGER update_flows_updated_at
  BEFORE UPDATE ON public.flows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_flow_nodes_updated_at
  BEFORE UPDATE ON public.flow_nodes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================
-- Indexes for performance
-- =============================================
CREATE INDEX idx_flows_user_id ON public.flows(user_id);
CREATE INDEX idx_flows_status ON public.flows(status);
CREATE INDEX idx_flow_versions_flow_id ON public.flow_versions(flow_id);
CREATE INDEX idx_flow_nodes_flow_id ON public.flow_nodes(flow_id);
CREATE INDEX idx_flow_runs_flow_id ON public.flow_runs(flow_id);
CREATE INDEX idx_flow_runs_user_id ON public.flow_runs(user_id);
CREATE INDEX idx_flow_runs_status ON public.flow_runs(status);
CREATE INDEX idx_flow_test_runs_flow_id ON public.flow_test_runs(flow_id);
CREATE INDEX idx_flow_test_runs_user_id ON public.flow_test_runs(user_id);
