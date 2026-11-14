/**
 * Worker-wide local-time settings and typed per-attempt temporal context.
 * Personal selections (including birthday and hemisphere override) are never
 * seeded here; the singleton's timezone is migrated only when the existing
 * provisioned feature zones agree.
 */
import type { Migration } from "@companion/postgres";

const AUTHORITATIVE_TIME_SETTINGS = `
DO $$
DECLARE
  configured_zones text[] := ARRAY[]::text[];
  candidate text;
  distinct_zones integer;
BEGIN
  IF to_regclass('memory_behavior') IS NOT NULL THEN
    EXECUTE 'SELECT timezone FROM memory_behavior WHERE id = ''behavior''' INTO candidate;
    IF candidate IS NOT NULL AND length(btrim(candidate)) > 0 THEN
      configured_zones := array_append(configured_zones, candidate);
    END IF;
  END IF;
  IF to_regclass('relationship_settings') IS NOT NULL THEN
    EXECUTE 'SELECT timezone FROM relationship_settings WHERE id = true' INTO candidate;
    IF candidate IS NOT NULL AND length(btrim(candidate)) > 0 THEN
      configured_zones := array_append(configured_zones, candidate);
    END IF;
  END IF;
  IF to_regclass('routine_settings') IS NOT NULL THEN
    EXECUTE 'SELECT timezone FROM routine_settings WHERE id = true' INTO candidate;
    IF candidate IS NOT NULL AND length(btrim(candidate)) > 0 THEN
      configured_zones := array_append(configured_zones, candidate);
    END IF;
  END IF;
  SELECT count(DISTINCT zone) INTO distinct_zones FROM unnest(configured_zones) AS zones(zone);
  IF distinct_zones > 1 THEN
    RAISE EXCEPTION 'authoritative timezone migration blocked: existing feature timezone settings conflict; reconcile them before retrying';
  END IF;
END $$;

CREATE TABLE companion_time_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  timezone text CHECK (timezone IS NULL OR length(btrim(timezone)) > 0),
  season_hemisphere text CHECK (season_hemisphere IS NULL OR season_hemisphere IN ('north', 'south')),
  birthday_month smallint,
  birthday_day smallint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((birthday_month IS NULL) = (birthday_day IS NULL)),
  CHECK (
    birthday_month IS NULL OR
    (birthday_month BETWEEN 1 AND 12 AND birthday_day BETWEEN 1 AND
      CASE birthday_month
        WHEN 2 THEN 29
        WHEN 4 THEN 30 WHEN 6 THEN 30 WHEN 9 THEN 30 WHEN 11 THEN 30
        ELSE 31
      END)
  )
);

DO $$
DECLARE
  configured_zones text[] := ARRAY[]::text[];
  candidate text;
BEGIN
  IF to_regclass('memory_behavior') IS NOT NULL THEN
    EXECUTE 'SELECT timezone FROM memory_behavior WHERE id = ''behavior''' INTO candidate;
    IF candidate IS NOT NULL AND length(btrim(candidate)) > 0 THEN
      configured_zones := array_append(configured_zones, candidate);
    END IF;
  END IF;
  IF to_regclass('relationship_settings') IS NOT NULL THEN
    EXECUTE 'SELECT timezone FROM relationship_settings WHERE id = true' INTO candidate;
    IF candidate IS NOT NULL AND length(btrim(candidate)) > 0 THEN
      configured_zones := array_append(configured_zones, candidate);
    END IF;
  END IF;
  IF to_regclass('routine_settings') IS NOT NULL THEN
    EXECUTE 'SELECT timezone FROM routine_settings WHERE id = true' INTO candidate;
    IF candidate IS NOT NULL AND length(btrim(candidate)) > 0 THEN
      configured_zones := array_append(configured_zones, candidate);
    END IF;
  END IF;
  INSERT INTO companion_time_settings (id, timezone)
  VALUES (true, (SELECT min(zone) FROM unnest(configured_zones) AS zones(zone)))
  ON CONFLICT (id) DO NOTHING;
END $$;
`;

const TRACE_ATTEMPT_TEMPORAL_CONTEXT = `
ALTER TABLE trace_attempt ADD COLUMN temporal_timezone text;
ALTER TABLE trace_attempt ADD COLUMN temporal_as_of timestamptz;
ALTER TABLE trace_attempt ADD COLUMN temporal_local_date date;
ALTER TABLE trace_attempt ADD COLUMN temporal_local_time time without time zone;
ALTER TABLE trace_attempt ADD COLUMN temporal_season text
  CHECK (temporal_season IS NULL OR temporal_season IN ('spring', 'summer', 'autumn', 'winter'));
ALTER TABLE trace_attempt ADD COLUMN temporal_occasion_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE trace_attempt ADD COLUMN temporal_occasion_context text
  CHECK (temporal_occasion_context IS NULL OR length(btrim(temporal_occasion_context)) > 0);
ALTER TABLE trace_attempt ADD CONSTRAINT trace_attempt_temporal_local_fields_shape CHECK (
  (temporal_timezone IS NULL AND temporal_local_date IS NULL AND temporal_local_time IS NULL)
  OR
  (temporal_timezone IS NOT NULL AND temporal_local_date IS NOT NULL AND temporal_local_time IS NOT NULL)
);
`;

export const temporalMigrations: readonly Migration[] = [
  { id: "0016_authoritative_temporal_context", sql: AUTHORITATIVE_TIME_SETTINGS },
  { id: "0017_trace_attempt_temporal_context", sql: TRACE_ATTEMPT_TEMPORAL_CONTEXT },
];
