INSERT INTO public.credit_costs (feature, label, model, cost, pricing_type)
VALUES ('remove_background', 'Remove Background (BiRefNet)', 'replicate-birefnet', 10, 'fixed')
ON CONFLICT DO NOTHING;