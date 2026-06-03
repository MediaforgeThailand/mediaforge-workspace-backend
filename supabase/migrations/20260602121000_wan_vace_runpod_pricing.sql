-- Workspace VFX: Wan 2.1 VACE 1.3B on RunPod.
-- This is an MVP fixed-credit row so strict workspace pricing can run
-- before we have real RTX 4000 Ada timing telemetry for per-second billing.

delete from public.credit_costs
where feature = 'generate_freepik_video'
  and model in (
    'wan2.1-vace-1.3b-runpod',
    'wan2.1-vace-1.3b-runpod:480p'
  );

insert into public.credit_costs (
  feature,
  model,
  label,
  cost,
  pricing_type,
  provider,
  price_key,
  source,
  source_url,
  provider_unit,
  notes,
  created_at,
  updated_at
) values (
  'generate_freepik_video',
  'wan2.1-vace-1.3b-runpod',
  'Wan 2.1 VACE 1.3B on RunPod',
  900,
  'fixed',
  'runpod',
  'wan2.1-vace-1.3b-runpod',
  'official_docs',
  'https://github.com/Wan-Video/Wan2.1',
  'per short VACE video job',
  'Initial fixed MVP price for source video + mask video + reference image Wan VACE jobs on RTX 4000 Ada. Defaults target 480p and 49 frames; tune after runtime telemetry.',
  now(),
  now()
);
