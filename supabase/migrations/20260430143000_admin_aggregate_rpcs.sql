create index if not exists idx_flows_user_created
  on public.flows (user_id, created_at desc);

create index if not exists idx_flows_status_updated
  on public.flows (status, updated_at desc);

create index if not exists idx_flow_reviews_flow_created
  on public.flow_reviews (flow_id, created_at desc);

create index if not exists idx_workspace_generation_jobs_created_status
  on public.workspace_generation_jobs (created_at desc, status);

create index if not exists idx_workspace_generation_events_created_feature_model
  on public.workspace_generation_events (created_at desc, feature, model);

create or replace function public.admin_dashboard_stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with flow_counts as (
    select status, count(*)::bigint as total
    from public.flows
    group by status
  )
  select jsonb_build_object(
    'statusCounts',
    coalesce(
      (select jsonb_object_agg(status, total) from flow_counts),
      '{}'::jsonb
    ),
    'pendingReviews',
    coalesce(
      (select count(*)::bigint from public.flow_reviews where decision = 'pending'),
      0
    ),
    'totalRevenue',
    coalesce(
      (select sum(total_revenue)::bigint from public.flow_metrics),
      0
    ),
    'totalFlows',
    coalesce((select sum(total) from flow_counts), 0)
  );
$$;

comment on function public.admin_dashboard_stats() is
  'Returns admin dashboard KPI counts without loading flows and flow_metrics rows into the edge runtime.';

create or replace function public.workspace_generation_status_counts(
  p_since timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with rows as (
    select
      case
        when status = 'queued' then 'processing'
        when status = 'running' then 'running'
        when status in ('failed', 'permanent_failed') and coalesce(credits_refunded, 0) > 0 then 'failed_refunded'
        when status in ('failed', 'permanent_failed') then 'failed'
        else coalesce(status, 'unknown')
      end as status_bucket
    from public.workspace_generation_jobs
    where created_at >= p_since
  ),
  counts as (
    select status_bucket, count(*)::bigint as total
    from rows
    group by status_bucket
  )
  select jsonb_build_object(
    'since',
    p_since,
    'counts',
    coalesce(
      (select jsonb_object_agg(status_bucket, total) from counts),
      '{}'::jsonb
    ) || jsonb_build_object(
      'total',
      coalesce((select sum(total) from counts), 0)
    )
  );
$$;

comment on function public.workspace_generation_status_counts(timestamptz) is
  'Returns 7-day style generation status buckets for the admin generation log KPI cards.';

create or replace function public.admin_workspace_generation_summary(
  p_since timestamptz,
  p_until timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with normalized_bounds as (
    select
      least(p_since, p_until) as since_at,
      greatest(p_since, p_until) as until_at
  ),
  windowed as (
    select
      created_at,
      coalesce(nullif(feature, ''), 'other') as feature,
      coalesce(nullif(model, ''), 'unknown') as model,
      coalesce(output_tier, 'unknown') as output_tier,
      greatest(coalesce(output_count, 1), 1)::bigint as generated_count,
      coalesce(credits_spent, 0)::numeric as credits_spent
    from public.workspace_generation_events, normalized_bounds
    where created_at >= normalized_bounds.since_at
      and created_at <= normalized_bounds.until_at
  ),
  feature_totals as (
    select
      feature,
      sum(generated_count)::bigint as total_count,
      sum(credits_spent)::numeric as total_credits
    from windowed
    group by feature
  ),
  model_totals as (
    select
      model,
      feature,
      sum(generated_count)::bigint as total_count,
      sum(credits_spent)::numeric as total_credits
    from windowed
    group by model, feature
  ),
  tier_totals as (
    select
      output_tier as tier,
      feature,
      sum(generated_count)::bigint as total_count
    from windowed
    group by output_tier, feature
  ),
  day_feature_totals as (
    select
      date_trunc('day', created_at)::date as day,
      feature,
      sum(generated_count)::bigint as total_count
    from windowed
    group by date_trunc('day', created_at)::date, feature
  ),
  chart_bounds as (
    select
      greatest(
        date_trunc('day', since_at),
        date_trunc('day', until_at) - interval '59 days'
      )::date as series_start,
      date_trunc('day', until_at)::date as series_end
    from normalized_bounds
  ),
  day_series as (
    select generate_series(series_start, series_end, interval '1 day')::date as day
    from chart_bounds
  ),
  timeseries as (
    select
      ds.day,
      coalesce(sum(dft.total_count) filter (where dft.feature = 'image'), 0)::bigint as images,
      coalesce(sum(dft.total_count) filter (where dft.feature = 'video'), 0)::bigint as videos,
      coalesce(sum(dft.total_count) filter (where dft.feature = 'audio'), 0)::bigint as audio,
      coalesce(sum(dft.total_count) filter (where dft.feature not in ('image', 'video', 'audio')), 0)::bigint as other
    from day_series ds
    left join day_feature_totals dft on dft.day = ds.day
    group by ds.day
  )
  select jsonb_build_object(
    'range',
    jsonb_build_object(
      'since', (select since_at from normalized_bounds),
      'until', (select until_at from normalized_bounds)
    ),
    'totals',
    jsonb_build_object(
      'images', coalesce((select total_count from feature_totals where feature = 'image'), 0),
      'videos', coalesce((select total_count from feature_totals where feature = 'video'), 0),
      'audio', coalesce((select total_count from feature_totals where feature = 'audio'), 0),
      'other', coalesce((select sum(total_count) from feature_totals where feature not in ('image', 'video', 'audio')), 0),
      'grand_total', coalesce((select sum(total_count) from feature_totals), 0),
      'credits_spent', coalesce((select sum(total_credits) from feature_totals), 0)
    ),
    'by_model',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'model', model,
            'feature', feature,
            'count', total_count,
            'credits', total_credits
          )
          order by total_count desc, model asc
        )
        from model_totals
      ),
      '[]'::jsonb
    ),
    'by_tier',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'tier', tier,
            'feature', feature,
            'count', total_count
          )
          order by total_count desc, tier asc
        )
        from tier_totals
      ),
      '[]'::jsonb
    ),
    'by_feature',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'feature', feature,
            'count', total_count
          )
          order by total_count desc, feature asc
        )
        from feature_totals
      ),
      '[]'::jsonb
    ),
    'timeseries',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'date', to_char(day, 'YYYY-MM-DD'),
            'images', images,
            'videos', videos,
            'audio', audio,
            'other', other
          )
          order by day asc
        )
        from timeseries
      ),
      '[]'::jsonb
    )
  );
$$;

comment on function public.admin_workspace_generation_summary(timestamptz, timestamptz) is
  'Returns workspace generation analytics summaries as pre-aggregated JSON for the admin analytics page.';

grant execute on function public.admin_dashboard_stats() to authenticated, service_role;
grant execute on function public.workspace_generation_status_counts(timestamptz) to authenticated, service_role;
grant execute on function public.admin_workspace_generation_summary(timestamptz, timestamptz) to authenticated, service_role;
