-- Workspace credit runtime + guided pricing catalog support.
--
-- Adds the metadata admin UI needs to show model/provider/source detail,
-- and adds one-time charge tracking to background jobs so retry loops do
-- not double-bill users.

alter table public.credit_costs
  add column if not exists provider text,
  add column if not exists price_key text,
  add column if not exists resolution text,
  add column if not exists quality text,
  add column if not exists source text,
  add column if not exists source_url text,
  add column if not exists source_ratio numeric,
  add column if not exists provider_unit text,
  add column if not exists notes text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.workspace_generation_jobs
  add column if not exists credits_charged integer not null default 0,
  add column if not exists credits_refunded integer not null default 0,
  add column if not exists credit_team_id uuid;

create index if not exists workspace_generation_jobs_credit_team_idx
  on public.workspace_generation_jobs (credit_team_id, created_at desc)
  where credit_team_id is not null;

-- GPT Image 2 detailed rows. Base values are Flow ERP 1K quality costs
-- converted from Flow ratio 125 credits/THB to Workspace 50 credits/THB,
-- then scaled by Workspace resolution tier for the sizes exposed in the UI.
with rows(feature, model, label, cost, pricing_type, provider, price_key, resolution, quality, source, source_url, source_ratio, provider_unit, notes) as (
  values
    ('generate_openai_image','gpt-image-2-low','GPT Image 2 Low (legacy fallback)',3,'per_operation','openai','gpt-image-2:1k:low','1K','low','flow_erp_converted','https://platform.openai.com/docs/pricing',0.4,'per image','Legacy quality-only fallback imported from Flow ERP and converted 125->50.'),
    ('generate_openai_image','gpt-image-2-medium','GPT Image 2 Medium (legacy fallback)',20,'per_operation','openai','gpt-image-2:1k:medium','1K','medium','flow_erp_converted','https://platform.openai.com/docs/pricing',0.4,'per image','Legacy quality-only fallback imported from Flow ERP and converted 125->50.'),
    ('generate_openai_image','gpt-image-2-high','GPT Image 2 High (legacy fallback)',80,'per_operation','openai','gpt-image-2:1k:high','1K','high','flow_erp_converted','https://platform.openai.com/docs/pricing',0.4,'per image','Legacy quality-only fallback imported from Flow ERP and converted 125->50.'),
    ('generate_openai_image','gpt-image-2:1k:low','GPT Image 2 1K Low',3,'per_operation','openai','gpt-image-2:1k:low','1K','low','flow_erp_converted','https://platform.openai.com/docs/pricing',0.4,'per image','Tier fallback for any 1K size without an exact row.'),
    ('generate_openai_image','gpt-image-2:1k:medium','GPT Image 2 1K Medium',20,'per_operation','openai','gpt-image-2:1k:medium','1K','medium','flow_erp_converted','https://platform.openai.com/docs/pricing',0.4,'per image','Tier fallback for any 1K size without an exact row.'),
    ('generate_openai_image','gpt-image-2:1k:high','GPT Image 2 1K High',80,'per_operation','openai','gpt-image-2:1k:high','1K','high','flow_erp_converted','https://platform.openai.com/docs/pricing',0.4,'per image','Tier fallback for any 1K size without an exact row.'),
    ('generate_openai_image','gpt-image-2:2k:low','GPT Image 2 2K Low',8,'per_operation','openai','gpt-image-2:2k:low','2K','low','workspace_catalog','https://platform.openai.com/docs/pricing',0.4,'per image','Workspace recommended 2K tier. Adjust after provider invoice reconciliation.'),
    ('generate_openai_image','gpt-image-2:2k:medium','GPT Image 2 2K Medium',50,'per_operation','openai','gpt-image-2:2k:medium','2K','medium','workspace_catalog','https://platform.openai.com/docs/pricing',0.4,'per image','Workspace recommended 2K tier. Adjust after provider invoice reconciliation.'),
    ('generate_openai_image','gpt-image-2:2k:high','GPT Image 2 2K High',200,'per_operation','openai','gpt-image-2:2k:high','2K','high','workspace_catalog','https://platform.openai.com/docs/pricing',0.4,'per image','Workspace recommended 2K tier. Adjust after provider invoice reconciliation.'),
    ('generate_openai_image','gpt-image-2:4k:low','GPT Image 2 4K Low',18,'per_operation','openai','gpt-image-2:4k:low','4K','low','workspace_catalog','https://platform.openai.com/docs/pricing',0.4,'per image','Workspace recommended 4K tier. Adjust after provider invoice reconciliation.'),
    ('generate_openai_image','gpt-image-2:4k:medium','GPT Image 2 4K Medium',120,'per_operation','openai','gpt-image-2:4k:medium','4K','medium','workspace_catalog','https://platform.openai.com/docs/pricing',0.4,'per image','Workspace recommended 4K tier. Adjust after provider invoice reconciliation.'),
    ('generate_openai_image','gpt-image-2:4k:high','GPT Image 2 4K High',480,'per_operation','openai','gpt-image-2:4k:high','4K','high','workspace_catalog','https://platform.openai.com/docs/pricing',0.4,'per image','Workspace recommended 4K tier. Adjust after provider invoice reconciliation.'),
    ('text_to_speech','google-tts-studio','Google Cloud TTS Studio / 1K chars',280,'per_1k_chars','google','google-tts-studio','text','studio','official_docs','https://cloud.google.com/text-to-speech/pricing',null,'per 1K chars','Google Cloud Studio voice pricing normalized to Workspace credits.'),
    ('text_to_speech','google-tts-neural2','Google Cloud TTS Neural2 / 1K chars',28,'per_1k_chars','google','google-tts-neural2','text','neural2','official_docs','https://cloud.google.com/text-to-speech/pricing',null,'per 1K chars','Google Cloud Neural2 voice pricing normalized to Workspace credits.'),
    ('text_to_speech','google-tts-wavenet','Google Cloud TTS WaveNet / 1K chars',28,'per_1k_chars','google','google-tts-wavenet','text','wavenet','official_docs','https://cloud.google.com/text-to-speech/pricing',null,'per 1K chars','Google Cloud WaveNet voice pricing normalized to Workspace credits.'),
    ('video_to_prompt','gemini-video-understanding','Video to Prompt (Gemini)',10,'per_operation','google','gemini-video-understanding','text','standard','workspace_catalog','https://ai.google.dev/gemini-api/docs/pricing',null,'per analysis','Flat Workspace credit for short inline video analysis.'),
    ('model_3d','tripo3d-v3.1','Tripo3D v3.1',80,'per_operation','tripo3d','tripo3d-v3.1','model','detailed','workspace_catalog','https://www.tripo3d.ai/',null,'per model','Workspace recommended row; reconcile against Tripo invoice/API plan.'),
    ('model_3d','tripo3d-p1','Tripo3D P1',120,'per_operation','tripo3d','tripo3d-p1','model','premium','workspace_catalog','https://www.tripo3d.ai/',null,'per model','Workspace recommended row; reconcile against Tripo invoice/API plan.'),
    ('model_3d','tripo3d-turbo','Tripo3D Turbo',50,'per_operation','tripo3d','tripo3d-turbo','model','fast','workspace_catalog','https://www.tripo3d.ai/',null,'per model','Workspace recommended row; reconcile against Tripo invoice/API plan.')
)
insert into public.credit_costs
  (feature, model, label, cost, pricing_type, provider, price_key, resolution, quality, source, source_url, source_ratio, provider_unit, notes)
select * from rows
on conflict (feature, COALESCE(model, '__default__'), COALESCE(duration_seconds, 0), COALESCE(has_audio, false))
do update set
  label = excluded.label,
  cost = excluded.cost,
  pricing_type = excluded.pricing_type,
  provider = excluded.provider,
  price_key = excluded.price_key,
  resolution = excluded.resolution,
  quality = excluded.quality,
  source = excluded.source,
  source_url = excluded.source_url,
  source_ratio = excluded.source_ratio,
  provider_unit = excluded.provider_unit,
  notes = excluded.notes,
  updated_at = now();
