ALTER TABLE historical_observations ADD COLUMN source_observation_key TEXT;
ALTER TABLE historical_observations ADD COLUMN source_station_id TEXT;
ALTER TABLE historical_observations ADD COLUMN observation_time_basis TEXT
  CHECK (observation_time_basis IS NULL OR observation_time_basis IN ('provider_observation', 'predicted_event', 'sample_date', 'inferred_snapshot'));
ALTER TABLE historical_observations ADD COLUMN source_configuration_version TEXT;

CREATE INDEX IF NOT EXISTS historical_observations_source_observation
  ON historical_observations(source_observation_key);
CREATE INDEX IF NOT EXISTS historical_observations_area_latest
  ON historical_observations(beach_area, observation_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS historical_ingestion_runs_job_latest
  ON historical_ingestion_runs(job, stored_at DESC);
