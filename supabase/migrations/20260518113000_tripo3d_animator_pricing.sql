delete from public.credit_costs
where feature = 'model_3d'
  and model in (
    'tripo3d-import',
    'tripo3d-prerigcheck',
    'tripo3d-rig',
    'tripo3d-retarget',
    'tripo3d-conversion'
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
    'model_3d',
    'tripo3d-import',
    'Tripo3D Import Model',
    1,
    'per_operation',
    'tripo3d',
    'import_model',
    'official_docs',
    'https://docs.tripo3d.ai/model-generation/import-model.html',
    'per import',
    'Tripo lists import_model as free; Workspace charges a 1-credit infrastructure floor for upload and job orchestration.'
  ),
  (
    'model_3d',
    'tripo3d-prerigcheck',
    'Tripo3D Pre-Rig Check',
    1,
    'per_operation',
    'tripo3d',
    'animate_prerigcheck',
    'official_docs',
    'https://docs.tripo3d.ai/animation/pre-rig-check-v2-0-20250506.html',
    'per check',
    'Tripo lists pre-rig check as free; Workspace charges a 1-credit infrastructure floor so the credit path stays positive.'
  ),
  (
    'model_3d',
    'tripo3d-rig',
    'Tripo3D Auto Rig',
    250,
    'per_operation',
    'tripo3d',
    'animate_rig',
    'official_docs',
    'https://docs.tripo3d.ai/animation/rig-v2-5-20260210.html',
    'per rig',
    'Official Tripo rig cost is 25 credits; Workspace model_3d pricing uses the existing approximate 10x provider-credit convention.'
  ),
  (
    'model_3d',
    'tripo3d-retarget',
    'Tripo3D Animation Retarget',
    100,
    'per_operation',
    'tripo3d',
    'animate_retarget',
    'official_docs',
    'https://docs.tripo3d.ai/animation/retarget.html',
    'per animation task',
    'Official Tripo retarget cost is 10 credits per animation; batch mode supports up to five presets per task.'
  ),
  (
    'model_3d',
    'tripo3d-conversion',
    'Tripo3D Export Conversion',
    50,
    'per_operation',
    'tripo3d',
    'convert_model',
    'official_docs',
    'https://docs.tripo3d.ai/export/conversion.html',
    'per conversion',
    'Official Tripo conversion base cost is 5 credits plus optional conversion surcharges; update once invoice/SKU data is reconciled.'
  );
