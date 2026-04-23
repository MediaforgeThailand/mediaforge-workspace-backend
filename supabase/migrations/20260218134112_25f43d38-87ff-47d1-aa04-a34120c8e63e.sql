
-- Create admin audit log table
CREATE TABLE public.admin_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id uuid NOT NULL,
  action text NOT NULL,
  target_table text NOT NULL,
  target_user_id uuid,
  details jsonb DEFAULT '{}'::jsonb,
  ip_address text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

-- Only admins can view logs
CREATE POLICY "Admins can view audit logs"
ON public.admin_audit_logs FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

-- Only admins can insert logs
CREATE POLICY "Admins can insert audit logs"
ON public.admin_audit_logs FOR INSERT
WITH CHECK (has_role(auth.uid(), 'admin'::app_role) AND admin_user_id = auth.uid());

-- No one can update or delete audit logs (immutable)
-- Intentionally no UPDATE/DELETE policies

-- Index for common queries
CREATE INDEX idx_audit_logs_admin ON public.admin_audit_logs (admin_user_id, created_at DESC);
CREATE INDEX idx_audit_logs_target ON public.admin_audit_logs (target_user_id, created_at DESC);
CREATE INDEX idx_audit_logs_action ON public.admin_audit_logs (action, created_at DESC);
