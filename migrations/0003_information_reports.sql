PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS information_reports (
  id TEXT PRIMARY KEY,
  client_report_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'inReview', 'resolved', 'dismissed', 'duplicate')),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  category TEXT NOT NULL CHECK (category IN ('beachOrAccessInformation', 'mapPinOrDirections', 'facilityOrAmenity', 'officialSourceOrWebsiteLink', 'beachConditionDisplay', 'appDisplayOrTechnicalProblem', 'somethingElse')),
  message TEXT NOT NULL,
  contact_email TEXT,
  beach_id TEXT,
  beach_access_id TEXT,
  map_poi_id TEXT,
  source_id TEXT,
  learn_article_id TEXT,
  screen_id TEXT NOT NULL,
  context_title TEXT,
  catalog_version TEXT,
  app_version TEXT NOT NULL,
  app_build TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'iOS'),
  client_created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolution_note TEXT,
  duplicate_of_report_id TEXT REFERENCES information_reports(id),
  notification_status TEXT NOT NULL DEFAULT 'pending' CHECK (notification_status IN ('pending', 'sent', 'failed')),
  notification_error TEXT,
  CHECK (length(message) BETWEEN 10 AND 1500),
  CHECK (contact_email IS NULL OR length(contact_email) <= 254)
);

CREATE INDEX IF NOT EXISTS information_reports_queue
  ON information_reports(status, received_at DESC);
CREATE INDEX IF NOT EXISTS information_reports_beach
  ON information_reports(beach_id, received_at DESC);

CREATE TABLE IF NOT EXISTS information_report_history (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES information_reports(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS information_report_history_report
  ON information_report_history(report_id, created_at ASC);
