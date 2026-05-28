delete from public.credit_costs
where feature = 'generate_qwen_image'
  and model in (
    'qwen-image-runpod',
    'qwen-image-edit-2511-runpod'
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
  notes
) values
  (
    'generate_qwen_image',
    'qwen-image-runpod',
    'Qwen Image on Runpod',
    180,
    'per_operation',
    'runpod',
    'qwen-image-runpod',
    'official_docs',
    'https://docs.comfy.org/tutorials/image/qwen/qwen-image',
    'per image',
    'MVP pricing for self-hosted Qwen Image on Runpod GPU. Covers queueing, GPU runtime, storage, and image rehosting; tune after measured runtime/cost telemetry.'
  ),
  (
    'generate_qwen_image',
    'qwen-image-edit-2511-runpod',
    'Qwen Image Edit 2511 on Runpod',
    260,
    'per_operation',
    'runpod',
    'qwen-image-edit-2511-runpod',
    'official_docs',
    'https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit-2511',
    'per image edit',
    'MVP pricing for Qwen Image Edit 2511 on Runpod GPU. Higher baseline reflects reference-image conditioning and longer default 40-step workflow.'
  );
