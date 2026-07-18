

# Alabama Beach Flag API Architecture

Last updated: 2026-07-05

## Overview

The Alabama Beach Flag API is a Cloudflare Worker backend that supports the Alabama Beach Flag iOS app, widget, and future public-facing services.

The backend is responsible for collecting, normalizing, caching, and serving beach-related data from official and trusted sources. This keeps the iOS app lightweight and allows backend logic to be improved without requiring every change to go through App Store review.

Current production Worker:

```txt
https://alabamabeachflag-api.sparkelectricalservicesllc.workers.dev
```

## Project Goals

The backend should:

- Prefer official data sources whenever available.
- Clearly distinguish official, estimated, unavailable, and future data sources.
- Cache recent data in Cloudflare KV so the app can load quickly.
- Protect the app from upstream outages, slow third-party services, and format changes.
- Keep beach-specific logic out of the iOS app where possible.
- Support future features such as WeatherKit, push notifications, Vibrio risk, sargassum, and Android.

## High-Level Data Flow

```txt
Official / Trusted Data Sources
        ↓
Provider Services
        ↓
Refresh Jobs
        ↓
Cloudflare KV Cache
        ↓
Worker API Routes
        ↓
iOS App / Widget / Website / Future Clients
```

## Runtime Platform

The backend runs on Cloudflare Workers.

Primary Cloudflare resources:

- Worker script: `alabamabeachflag-api`
- KV namespace binding: `BEACH_DATA`
- Scheduled triggers for background refresh jobs
- Worker routes for API responses

## Folder Structure

```txt
src/
  index.ts
  registry/
  services/
    adem/
    arcgis/
    beachConditions/
    beachFlags/
    beachForecast/
    marine/
    noaa/
    refresh/
    weather/
  types/
  utils/

test/
wrangler.jsonc
ARCHITECTURE.md
```

## Main Entry Point

```txt
src/index.ts
```

This file contains the main Worker handlers:

- `fetch` handler for HTTP API requests
- `scheduled` handler for Cloudflare cron triggers
- route dispatching
- refresh job selection based on cron schedule

## Scheduled Jobs

Cloudflare scheduled triggers refresh backend data on a predictable schedule.

Current intended schedule:

```txt
*/5 * * * *      Beach flags
*/15 * * * *     Beach conditions / weather-related data
0 */6 * * *      Water quality
```

The goal is to refresh fast-changing safety data more often while keeping slower-changing data on a less aggressive schedule.

### Beach Flags

Beach flags are safety-critical and can change during the day. These should remain one of the most frequent refresh jobs.

### Beach Conditions

Beach conditions include weather, marine, UV, water temperature, and forecast-style data. These change often, but generally do not need to refresh as aggressively as beach flags.

### Water Quality

Water quality data from ADEM changes less frequently and should not be refreshed every few minutes.

## Cloudflare KV Layout

Cloudflare KV is used as the backend cache.

KV stores the latest normalized data so the app does not need to call every upstream source directly.

Expected categories include:

```txt
flags
beach conditions
water quality
metadata / refresh status
```

KV should contain normalized app-ready data, not raw upstream responses unless there is a specific debugging or audit reason.

## Beach Registry

The beach registry defines the beaches supported by the backend.

The registry should answer questions like:

- What is the beach ID?
- What is the display name?
- Which municipality or source owns the data?
- Does this beach have official flag data?
- Does this beach use estimated data?
- Does this beach have water quality data?
- Does this beach have weather or marine data?

The registry should be treated as the source of truth for supported beaches.

## Beach Flag Providers

Beach flag providers collect and normalize beach flag status.

### Gulf Shores

Source type: official

Gulf Shores has an official beach flag source. The backend parses the current conditions and converts them into the app's normalized flag format.

Expected normalized fields:

```txt
primaryFlag
hasPurpleFlag
lastUpdated
sourceType
sourceName
```

### Orange Beach

Source type: official

Orange Beach has an official beach flag source. Multiple Orange Beach locations may share the same official city report.

### Fort Morgan

Source type: estimated

Fort Morgan does not currently publish an official beach flag feed. The backend estimates Fort Morgan conditions from nearby Gulf Shores data.

This should always remain clearly labeled as estimated.

Future Fort Morgan estimation may use:

- Gulf Shores flag status
- wind speed
- wind direction
- wave height
- swell period
- rip current risk
- local marine forecast data

### Dauphin Island

Source type: unavailable / not implemented

Dauphin Island publishes beach flag updates through Facebook rather than a stable official API or machine-readable public feed.

Until an official machine-readable source exists, the backend should not guess Dauphin Island beach flags.

Future options:

1. Official Dauphin Island API or RSS feed
2. Official town website page
3. Facebook Graph API, if accessible and authorized
4. Manual backend integration, if authorized

## Water Quality

Water quality is based on Alabama Department of Environmental Management coastal data.

Primary source:

```txt
https://adem.alabama.gov/coastal
```

Current backend behavior:

- Fetches official ADEM coastal water quality data
- Uses ArcGIS beach monitoring location data where needed
- Normalizes advisories and results into app-ready status values
- Caches latest results in KV

Water quality should remain separate from beach flags. A beach can have safe surf conditions but poor water quality, or vice versa.

## Beach Conditions

Beach conditions are broader environmental details shown in the app.

Current and planned categories include:

- air temperature
- water temperature
- UV index
- wind
- weather condition
- marine forecast data
- rip current risk
- severe weather alerts

Weather-related services should eventually be served from the backend so the app can rely on a single API instead of spreading logic across the iOS codebase.

## NOAA / Marine / Beach Forecast Data

NOAA and marine data support weather, water temperature, beach forecast, and future risk features.

Potential uses:

- surf conditions
- water temperature
- rip current outlook
- thunderstorm risk
- waterspout risk
- wave and wind conditions
- coastal forecast details

This data will become more important as the app moves toward smarter Fort Morgan estimation and future environmental features.

## WeatherKit Roadmap

WeatherKit is planned as a future backend-powered weather source.

Backend WeatherKit integration should:

- keep WeatherKit credentials out of the iOS app
- reduce app-side weather parsing logic
- allow backend caching
- allow server-side fallback behavior
- support richer weather detail screens
- support future severe weather alerts

WeatherKit should be added after shared HTTP handling and logging are improved.

## Future Environmental Features

Future backend-supported data sources may include:

- Vibrio risk
- sargassum presence
- harmful algal bloom information
- severe weather alerts
- rip current outlook improvements
- push notification triggers

These should be added carefully with clear source labeling and confidence levels.

## API Routes

The API should expose app-ready JSON.

### Internal factual verification

Phase 1 factual verification is isolated from production publishing and parser execution. It fetches the official Gulf Shores page through an independent parser and compares that state with the public `/v1/beach-flags` payload for:

- Gulf Shores Public Beach
- Gulf State Park Pavilion
- Little Lagoon Pass

The report checks public API availability, data age, Gulf Shores provider errors, missing locations, primary flag color, and purple advisory state. Data older than 45 minutes warns; data older than 90 minutes fails. Source-format changes warn without guessing.

`VerificationCoordinator`, a SQLite-backed Durable Object introduced by migration `v2-verification-coordinator`, claims one `America/Chicago` hourly slot before execution. Repeated requests for that slot return HTTP `409`. Successful reports write `verification:latest` and a dated KV record retained for 30 days.

The internal run and latest-report routes are protected by Cloudflare Access. The legacy refresh-secret fallback is disabled.

### Factual-verification alert state

Phase 2 keeps alert evaluation inside the verification subsystem and does not call production parsers, publishers, or refresh coordinators. The existing `VerificationCoordinator` serializes these transitions and persists `alert-state`:

```txt
pass + no incident      -> silent
warning/fail + none     -> open incident, notify once
same condition          -> update last-observed time, silent
changed/escalated       -> retain incident ID, notify once
pass + active incident  -> notify recovery, clear incident
```

The incident signature contains only affected check/location names and statuses, so changing age or diagnostic wording cannot create an alert storm. Notifications still contain concise current report diagnostics. Notification intent is saved before external delivery. This gives deterministic at-most-once behavior for a notification key and prevents storms, with the explicit tradeoff that an ambiguous or failed delivery is logged but not retried automatically. Delivery and alert-state failures are caught after report creation and cannot change a completed verification response.

The existing `*/15` scheduled handler invokes a missing-report monitor independently after weather refresh. At or after 7:30 AM and 12:30 PM in `America/Chicago`, it checks the latest due dated KV key. This accommodates normal scheduler delay, follows DST through `Intl.DateTimeFormat`, and needs no additional Cron Trigger. Duplicate checks converge on the same incident signature; a later missing scheduled slot is an incident update. A subsequent passing verification produces recovery.

`VERIFICATION_ALERTS_ENABLED` is the delivery-only kill switch and is explicitly false in production and staging. The delivery interface uses the native `VERIFICATION_ALERT_EMAIL` binding, restricted in Wrangler to sender `alerts@alabamabeachflag.com` and fixed destination `operations@alabamabeachflag.com`. Plain-text messages contain only environment, alert type, slot, Central timestamp, overall status, affected names, and concise diagnostics. This avoids third-party credentials and infrastructure; Cloudflare sending logs/metrics provide delivery operations.

Current and expected route categories:

```txt
GET /
GET /flags
GET /beaches
GET /beach-conditions
GET /water-quality
GET /health
```

The root route should identify the service and version.

Example:

```json
{
  "service": "Alabama Beach Flag API",
  "version": "1.0.0",
  "status": "online"
}
```

## Health Endpoint Roadmap

A future `/health` route should report backend status.

Example future response:

```json
{
  "status": "healthy",
  "kv": "ok",
  "lastFlagRefresh": "2026-07-05T12:00:00Z",
  "lastBeachConditionsRefresh": "2026-07-05T12:00:00Z",
  "lastWaterQualityRefresh": "2026-07-05T12:00:00Z",
  "version": "1.0.0"
}
```

This would make it easier to confirm whether the backend is healthy without digging through logs.

## Error Handling Principles

The backend should:

- avoid crashing because one upstream source failed
- return cached data when fresh data cannot be fetched
- clearly log provider failures
- distinguish unavailable data from failed data
- avoid pretending estimated data is official
- avoid showing stale data without timestamps

## Logging Principles

Logs should be consistent and easy to scan in Cloudflare.

Ideal log format:

```txt
[Flags] Starting refresh
[Flags] Gulf Shores: success
[Flags] Orange Beach: success
[Flags] Fort Morgan: estimated
[Flags] Dauphin Island: unavailable
[Flags] Finished refresh in 1.42s
```

Current implementation:

- Shared logger utility lives in `src/utils/logger.ts`
- Major refresh jobs log start, finish, duration, counts, and errors
- Log messages use consistent scopes such as `[Flags]`, `[Beach Conditions]`, `[Water Temperature]`, and `[Water Quality]`
- Provider and refresh errors should include useful context without creating noisy duplicate logs

## Shared HTTP Client

A shared HTTP client now centralizes outbound HTTP requests across providers and services.

The shared client supports:

- request timeout
- retry attempts
- exponential retry delay
- retry only on transient failures
- consistent User-Agent
- consistent labeled error messages
- optional response validation

This improves reliability across all providers and gives the backend one place to improve request behavior in the future.

## Source Type Rules

Every data response should clearly identify source type.

Recommended source types:

```txt
official
estimated
third_party
unavailable
unknown
```

Rules:

- Use `official` only when the data comes directly from the responsible government or agency source.
- Use `estimated` when backend logic infers conditions from nearby or supporting data.
- Use `third_party` when a trusted but non-official source is used.
- Use `unavailable` when no responsible source exists yet.
- Avoid `unknown` unless the backend truly cannot determine source quality.

## Deployment

Typical deployment command:

```sh
npx wrangler deploy
```

After deployment, verify:

- Worker URL loads
- scheduled triggers are correct
- KV binding is present
- Cloudflare logs show successful refresh jobs
- app and widget can still load expected JSON

## Testing

Tests live in:

```txt
test/
```

Current test coverage should verify:

- root API response
- route behavior
- provider parsing where practical
- refresh behavior where practical

Tests should be updated whenever the root API response or route behavior changes.

## Versioning

The backend should eventually expose a single backend version constant.

Example:

```ts
export const BACKEND_VERSION = "1.0.0";
```

This should be used by the root route, health route, logs, and future debugging tools.

## Future Roadmap

Planned or likely future backend improvements:

1. Centralized config file
2. `/health` endpoint
3. Backend version constant
4. WeatherKit backend integration
5. Improved Fort Morgan estimation model
6. Dauphin Island official source integration if available
7. Vibrio risk research and possible v2.0 feature
8. Sargassum data research and possible future feature
9. Push notification support for flag changes
10. Android-ready API support
11. Better automated tests
12. Complete controlled staging email validation, then separately approve production activation

Phase 1 factual verification was completed July 17, 2026. Phase 2 durable alert state, monitoring, and the disabled Cloudflare Email Service adapter were implemented July 18, 2026; staging validation and production activation remain pending. Verification of additional municipal sources remains future work.

## Development Philosophy

The backend should be built carefully and honestly.

Safety-related data should never be guessed without clear labeling. Official data should be preferred. Estimated data should be transparent. Unavailable data should be shown as unavailable rather than fabricated.

The long-term goal is not just to serve data, but to make Alabama Beach Flag a trustworthy beach safety platform for Alabama residents and visitors.
