PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS historical_observations (
  id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  observation_type TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK (record_kind IN ('observation', 'forecast', 'prediction', 'state', 'result')),
  beach_area TEXT,
  beach_id TEXT,
  provider TEXT NOT NULL,
  station_id TEXT,
  observed_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  value_numeric REAL,
  value_text TEXT,
  unit TEXT,
  normalized_value_numeric REAL,
  quality_flag TEXT,
  freshness_state TEXT,
  source_identifier TEXT,
  provider_metadata TEXT NOT NULL DEFAULT '{}',
  ingestion_version INTEGER NOT NULL DEFAULT 1,
  CHECK (value_numeric IS NOT NULL OR value_text IS NOT NULL),
  UNIQUE (logical_key, revision_hash),
  UNIQUE (logical_key, revision_number)
);

CREATE INDEX IF NOT EXISTS historical_observations_observed_at
  ON historical_observations(observed_at DESC);
CREATE INDEX IF NOT EXISTS historical_observations_source_latest
  ON historical_observations(provider, station_id, observation_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS historical_observations_beach_latest
  ON historical_observations(beach_id, observation_type, observed_at DESC);

CREATE TABLE IF NOT EXISTS historical_ingestion_runs (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  stored_at TEXT NOT NULL,
  attempted_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  error_code TEXT
);

CREATE INDEX IF NOT EXISTS historical_ingestion_runs_stored_at
  ON historical_ingestion_runs(stored_at DESC);
