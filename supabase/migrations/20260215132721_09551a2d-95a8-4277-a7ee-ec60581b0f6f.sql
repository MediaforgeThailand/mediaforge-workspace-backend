
-- Track individual stock downloads for quota management
CREATE TABLE public.stock_downloads (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  resource_id TEXT NOT NULL,
  resource_title TEXT,
  download_url TEXT,
  source TEXT NOT NULL DEFAULT 'freepik',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Index for monthly quota queries
CREATE INDEX idx_stock_downloads_user_month ON public.stock_downloads (user_id, created_at);
CREATE INDEX idx_stock_downloads_resource ON public.stock_downloads (user_id, resource_id);

-- Enable RLS
ALTER TABLE public.stock_downloads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own downloads"
  ON public.stock_downloads FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own downloads"
  ON public.stock_downloads FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Add stock_download to credit_costs
INSERT INTO public.credit_costs (feature, label, cost)
VALUES ('stock_download', 'Stock Image Download (over quota)', 5)
ON CONFLICT DO NOTHING;
