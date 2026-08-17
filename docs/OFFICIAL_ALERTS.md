# Official alerts (Phase 1)

This domain is additive and independent from beach flags, forecasts, announcements, and events. The submitted iOS 1.3.0 continues to fetch NWS alerts directly; `/v1/official-alerts` is a backend shadow API only.

## Source strategy

Every 15 minutes the Worker makes four conditional read-only requests to `https://api.weather.gov/alerts/active?point={lat,long}`, one for each ABF user-facing region. NWS point-query membership is the Phase 1 structured geographic authority. It avoids the old sender/headline/description locality test and requires only four requests per scheduled cycle. `ETag` and `Last-Modified` validators are retained per region. Requests use a named User-Agent, bounded response size, content-type validation, HTTPS host/path allowlisting, timeout, one retry with backoff, and validated redirects.

The region metadata version is `2026-08-17.v1`. Its small WGS84 shoreline boxes document conservative user-facing extents but are not jurisdiction boundaries and do not override NWS point-query membership. Replace them later with authoritative shoreline/jurisdiction data through a new version.

## Event policy

`src/officialAlerts/policy.ts` is the sole production allowlist and records a category, priority, and rationale for every event. It includes the 17 audited events plus Tropical Cyclone Local Statement, Beach Hazards Statement, Tsunami Warning/Advisory/Watch, and the current NWS Heat Advisory/Extreme Heat Warning/Extreme Heat Watch products. The heat products are intentionally included because exposure is directly relevant to beach visitors; a live read-only validation on August 17, 2026 returned a Heat Advisory for all four points. Unknown event names are not published. Special Marine Warning is `marineWeather`, never marine life.

## Identity, lifecycle, and outages

The stable public ID is the first 128 bits of SHA-256 over `nws`, a NUL separator, and the exact NWS feature ID. Repeated observations are idempotent. A successful region result replaces that region's membership. Missing previously active records become `superseded`; records at or past `expiresAt` become `expired`. History is bounded to 200 transitions. The public route independently filters expiry.

Failed or malformed region responses retain only the previous unexpired region membership. Data is `fresh` while every region has succeeded within 20 minutes, `stale` after that, and `unavailable` when any region has no success for more than 60 minutes. A valid empty response is healthy. A source outage never extends an alert past its issuer expiry.

## API

`GET /v1/official-alerts` returns all active alerts. `?region=gulfShores`, `orangeBeach`, `fortMorgan`, or `dauphinIsland` filters them. `?beach=` is a compatibility alias for the same region IDs. Ordering is severity, urgency, explicit event priority, newest onset/effective time, then stable ID.

`GET /admin/official-alerts/health` is authenticated and reports freshness, attempts/successes, HTTP state, parse failures, active count, and last data change. `POST /internal/refresh/official-alerts` is authenticated for manual shadow validation.

## Shadow comparison

`src/officialAlerts/shadow.ts` compares only policy outcomes; it never creates or publishes alerts. Tests document known differences: Extreme Wind Warning is backend-only because the legacy substring filter misses it; arbitrary event names containing `marine` can be legacy-only; Special Marine Warning is included by both but categorized correctly only by the backend. Live/captured comparison should additionally record the legacy free-text locality decision and ordering before iOS migration.

## Deferred

No iOS migration, push, IPAWS ingestion, Lulu classifier, production deployment, authoritative regional boundary dataset, D1 long-term audit archive, or operator UI is included in Phase 1.
