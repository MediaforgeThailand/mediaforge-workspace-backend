-- Veo 3.1 Standard pricing seed.
--
-- Adds the Google Veo 3.1 Standard model to the per-second video
-- pricing table. The frontend `availableModels.ts` already lists this
-- slug so the ERP Pricing Manager picks it up automatically; without
-- this row, dispatch would fall back to the workspace multiplier
-- default (which under-charges for Veo).
--
-- The cost (50) is a placeholder agreed with the operator — they'll
-- refine it once real Google pricing is reconciled with our credit
-- ratio (1 THB = 50 workspace credits).
--
-- Audio is bundled into Veo's render (no toggle), so we keep the
-- single base row (no `:audio` variant) — same pattern as Kling
-- models that don't expose audio separately. Resolution is left
-- NULL on this row; per-resolution overrides can be added later
-- (e.g. `veo-3.1-generate-preview:1080p`) when 1080p needs a
-- distinct rate.

WITH rows(feature, model, cost, label, pricing_type, provider, has_audio, resolution) AS (
  VALUES
    (
      'generate_freepik_video',
      'veo-3.1-generate-preview',
      50,
      'Google Veo 3.1 Standard',
      'per_second',
      'veo',
      false,
      NULL
    ),
    (
      'generate_freepik_video',
      'veo-3.1-generate-001',
      50,
      'Google Veo 3.1 Standard (alias)',
      'per_second',
      'veo',
      false,
      NULL
    )
)
INSERT INTO public.credit_costs (
  feature,
  model,
  cost,
  label,
  pricing_type,
  provider,
  has_audio,
  resolution
)
SELECT feature, model, cost, label, pricing_type, provider, has_audio, resolution
FROM rows
ON CONFLICT DO NOTHING;
