# Historical environmental data

## Executive summary and recommendation

Separate staging and production D1 databases now provide structured, indexed,
append-only observations and persisted ingestion diagnostics. The production database
is `alabama-beach-flag-historical-production` (`2367de8c-b0d9-47f0-b419-d1c15b701ad8`);
staging remains `alabama-beach-flag-historical-staging`
(`701101d9-f450-4bc5-b1ac-cfbf18854fee`). Each Wrangler configuration binds only its
matching database.

No Vibrio model, public route, provider priority, cache TTL, UI, version, or alerting
behavior is changed. Historical persistence occurs only after the live KV candidate
has passed its existing quality gates and has been committed. A historical failure is
logged and cannot change a completed live refresh into a failure.

## Current data flow audit

Scheduled jobs dispatch through one Durable Object coordinator per job. Providers are
fetched outside its final critical section; candidates pass quality gates and are then
published to `BEACH_DATA` KV. Public routes read those cached payloads.

| Data | Current source and timestamp quality | Cadence | Existing persistence |
| --- | --- | --- | --- |
| Beach flags | Gulf Shores and Orange Beach official pages; Fort Morgan estimate; pages expose current state but generally no immutable effective time | 5 min | latest KV snapshot |
| Water temperature | NOAA NDBC/CO-OPS selected using configured priority/fallback; immutable `observedAt`, station and freshness fields | 15 min | embedded in latest KV snapshot |
| Weather | NWS hourly forecast (not a true current observation) | 15 min | latest KV snapshot |
| UV | Open-Meteo current value, but the client currently discards the provider timestamp | 15 min | latest KV snapshot |
| Tide | NOAA predictions with event time, station, datum, units and fetch time | 15 min | embedded in latest KV snapshot |
| Water quality | ADEM workbook latest sample/result date and advisory state | 6 hours | latest KV snapshot |
| Alerts/rip outlook/events | Separate existing cache/event pipelines | varying | KV / existing event stores |

The operational-control, provider-health, job-health, verification, and beach-event
stores provide useful patterns but are state/audit-specific KV stores rather than a
relational environmental time series.

## Schema and integrity behavior

`historical_observations` stores one normalized scalar/state per row with provider,
station, beach, observation kind, observed/fetched/stored UTC timestamps, value/unit,
quality/freshness, source identity, metadata, and ingestion version. Indexed source,
beach, and time columns support diagnostics and later research without giant snapshots.

The logical key identifies source + station + beach + type + provider observation time.
The separate `source_observation_key` uses type + record kind + canonical provider +
physical station/source + observation time and deliberately excludes `beach_id`. It
therefore counts a shared physical source observation once while the logical key retains
every useful beach attribution. Rows also store `beach_area`, `source_station_id`,
`observation_time_basis`, and the narrow source-mapping version
`beach-source-mappings-2026-08-08-v1`. Existing pre-Phase-0 staging rows remain null in
these additive fields and are not rewritten.
Diagnostics use the same source dimensions as a compatibility fallback when counting
physical observations for those legacy null-key rows.

The revision hash identifies the received value, units, quality flag, and explicitly
stable source/provenance metadata. Revision-significant metadata is separated from stored audit
metadata: volatile locally derived values such as observation age and freshness state
do not create revisions, while stable source qualifiers such as datum, curve method,
advisory context, and purple-flag state do. Re-fetching identical content is ignored; corrected content at the same
logical observation time receives the next revision number. Rows are never updated or
replaced. Malformed values or timestamps are rejected.

`historical_ingestion_runs` records success/failure and attempted, inserted, duplicate,
and rejected counts. Observation inserts and their completed run record are sent in one
D1 `batch()`, which D1 executes transactionally. A failed batch rolls back and a separate
best-effort failed run with `atomic_batch_failed` is recorded. All timestamps are
ISO-8601 UTC. ADEM date-only values are stored
at UTC midnight and explicitly tagged with `timestampPrecision: date`; this avoids
pretending a sample time is known.

The timestamps have deliberately separate meanings:

- `observed_at` is the instant the provider says the measurement, prediction, result,
  or state refers to. When a source supplies only a date or no effective time, metadata
  records that reduced precision instead of treating receipt time as a known event time.
- `fetched_at` is when Alabama Beach Flag received the upstream response used by that
  refresh. It is not substituted for a provider observation time except for the clearly
  labeled, hourly beach-flag snapshot convention described below.
- `stored_at` is when the normalized row was durably appended to D1. It is generated by
  the collector and may be later than `fetched_at`.

`observation_time_basis` makes the common query time unambiguous:

- `provider_observation`: a provider measurement timestamp;
- `predicted_event`: a NOAA tide prediction event;
- `sample_date`: an ADEM date with no claimed time of day;
- `inferred_snapshot`: an hourly beach-flag snapshot derived from fetch time because
  the municipality did not publish an immutable effective timestamp.

Provider/source identity is stored separately from station/site identity. This preserves
the selected provider and actual station on every row, including when the normal primary
station is stale or unavailable and the live selection falls back to another configured
station. Local beach-calendar interpretation uses `America/Chicago`, including DST, but
database timestamps remain UTC; source-local date precision and relevant timezone facts
belong in provider metadata.

New rows use canonical machine provider IDs: `ndbc`, `noaa_coops`, `adem`,
`city_gulf_shores`, `city_orange_beach`, and `derived_gulf_shores`. Earlier staging rows
retain legacy provider strings. ADEM `station_id` and `source_station_id` now use the
actual configured ADEM site code (for example `COT_BYOU`) rather than the application
beach ID; `beach_id` remains the Alabama Beach Flag attribution.

## Initial collection scope

Implemented now:

- selected water-temperature observations, including the actual fallback station and
  stale/current classification;
- ADEM enterococcus results and advisory state;
- NOAA tide high/low predictions;
- official and estimated beach-flag hourly snapshots. Because municipal sources lack
  effective timestamps, five-minute refreshes are collapsed to hourly logical
  snapshots, with within-hour changes retained as revisions.

Intentionally deferred until trustworthy timestamps/raw fields are retained by the
provider clients: NWS forecast periods, Open-Meteo UV, observed weather and
precipitation, and raw ADEM revision qualifiers. NWS values currently used by the app
are forecasts and must never be mislabeled as observations. This is also why no
WeatherKit rows are collected: WeatherKit is present in the codebase but is not in the
active beach-condition refresh pipeline.

## Storage estimate

Conservative assumptions: 8 selected beach/station water-temperature mappings updated
hourly (192 rows/day), 8 hourly flag snapshots (192/day), about 36 tide extrema/day,
and 18 water-quality result/state rows per sampling update. This is roughly 420 rows/day
before uncommon revisions. At an intentionally conservative 1 KB per indexed row:

| Retention | Rows | Approximate storage |
| --- | ---: | ---: |
| 30 days | 12,600 | 13 MB |
| 1 year | 153,300 | 153 MB |
| 3 years | 459,900 | 460 MB |
| 5 years | 766,500 | 767 MB |

Actual SQLite row size must be measured after 30 days. Retain normalized raw history
for now. A paid D1 database has ample headroom; a free 500 MB database would likely
need archiving/downsampling around year three. Preserve corrections and water-quality
results indefinitely. If required later, archive old high-frequency flag snapshots to
R2 rather than deleting research-grade source observations.

## Migration and operations

Migrations are ordered and additive:

1. `0001_historical_observations.sql`: observation and ingestion-run foundation.
2. `0002_historical_provenance.sql`: physical source identity, actual source station,
   time basis, mapping version, area/source indexes, and job-health index.

Both migrations are applied to production and staging. Remote migration remains an
explicit release operation, not an implicit part of ordinary deployment.

## Internal diagnostics and security

`GET /admin/historical-data` uses the existing Cloudflare Access administrator
authentication and returns environment/configuration state, beach-attributed/logical/
physical counts, revision and timestamp summaries, persisted job health, last-24-hour
run totals, recent failures, per-dataset/provider coverage, and deterministic latest
rows per beach/source. It is `no-store`, GET-only, bounded, and no public history route
exists.

Production job expectations deliberately measure ingestion execution rather than
provider observation changes: flags run every 5 minutes and are late after 15 minutes;
beach conditions run every 15 minutes and are late after 45 minutes; water quality runs
every 6 hours and is late after 14 hours. Staging schedules only beach conditions, so
the other jobs report `not_scheduled` there.

## Risks and verification

Primary risks are provider outages, future station/provider changes, old staging rows
without Phase-0 provenance, and storage growth. Optional binding,
timestamp validation, explicit provider/station attribution, append-only revisions,
indexes, ingestion-version metadata, and post-publication error isolation mitigate
these risks.

Regression coverage includes extraction, fallback attribution, stale state, immutable
identity/duplicate behavior, revision identity, malformed rejection, UTC date boundary,
physical-source identity, atomic rollback, migrated SQLite schema, diagnostic health and
endpoint protection, and historical-write failure isolation.

The 21 early staging revisions were a deployment-transition artifact. Revision 1 used
the initial hash contract, which included freshness and full provider metadata; revision
2 used the corrected stable-metadata contract. Concrete tide pairs had identical values,
units, datum, station type, and curve method, while water-temperature pairs differed only
in fetch-derived age/freshness. The corrected contract already suppresses those cosmetic
changes, and regression tests retain legitimate value and stable-metadata corrections.

No historical backfill, public history API, observation-browser endpoint, CSV export,
admin Historical Data page, weather/UV/alert/rip-current/event history, or Vibrio model
is implemented.
