

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

Future improvement:

- Add a shared logger utility
- Standardize success, warning, and error messages
- Log refresh duration
- Log provider name and source type
- Avoid noisy duplicate logs

## Shared HTTP Client Roadmap

A shared HTTP client should eventually replace direct `fetch()` calls inside providers.

The shared client should support:

- request timeout
- retry attempts
- retry delay
- retry only on transient failures
- consistent User-Agent
- consistent error messages
- optional response validation

This will improve reliability across all providers.

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

1. Shared HTTP client with retries and timeout
2. Centralized logger
3. Centralized config file
4. `/health` endpoint
5. WeatherKit backend integration
6. Improved Fort Morgan estimation model
7. Dauphin Island official source integration if available
8. Vibrio risk research and possible v2.0 feature
9. Sargassum data research and possible future feature
10. Push notification support for flag changes
11. Android-ready API support
12. Better automated tests

## Development Philosophy

The backend should be built carefully and honestly.

Safety-related data should never be guessed without clear labeling. Official data should be preferred. Estimated data should be transparent. Unavailable data should be shown as unavailable rather than fabricated.

The long-term goal is not just to serve data, but to make Alabama Beach Flag a trustworthy beach safety platform for Alabama residents and visitors.