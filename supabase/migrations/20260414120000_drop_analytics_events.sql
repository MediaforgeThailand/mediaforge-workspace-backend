-- All analytics are now consolidated into PostHog.
-- Client-side: posthog-js (already in place)
-- Server-side: direct HTTP capture via _shared/posthogCapture.ts

-- Drop legacy client-side analytics table
DROP TABLE IF EXISTS analytics_events;

-- Drop legacy server-side API usage logs table
DROP TABLE IF EXISTS api_usage_logs;
