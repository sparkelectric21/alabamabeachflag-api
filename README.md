

# Alabama Beach Flag API

Backend API for the Alabama Beach Flag ecosystem.

This Cloudflare Worker powers the Alabama Beach Flag iOS app by collecting, normalizing, caching, and serving beach safety data from official and trusted sources.

## Features

- Official beach flag data where available
- Estimated conditions for supported beaches without official feeds
- ADEM water quality integration
- NOAA and marine data integration
- NOAA CO-OPS predicted tides, with local-date validation and safe per-beach availability
- Cloudflare KV caching
- Independent factual verification for Gulf Shores conditions
- Durable Object duplicate-slot protection for verification runs
- Shared HTTP client with retry and timeout handling
- Structured logging for scheduled refresh jobs
- Scheduled background refresh jobs
- App-ready JSON API

## Tech Stack

- Cloudflare Workers
- TypeScript
- Cloudflare KV
- Wrangler
- Vitest

## Project Structure

```text
src/
  index.ts
  registry/
  services/
  types/
  utils/

test/
wrangler.jsonc
ARCHITECTURE.md
README.md
```

## Local Development

Install dependencies:

```sh
npm install
```

Start the local Worker:

```sh
npx wrangler dev
```

Run tests:

```sh
npm test
```

Run a TypeScript type check:

```sh
npm run typecheck
```

## Administrative Access configuration

Production administrative routes require Cloudflare Access. Non-secret Access identifiers are configured in `wrangler.jsonc`; credentials remain local or in Cloudflare secrets:

- `ACCESS_TEAM_DOMAIN`: complete Cloudflare Access issuer URL.
- `ACCESS_AUD`: Access application audience.
- `ACCESS_ALLOWED_IDENTITIES`: comma-separated browser-user email addresses or subjects.
- `ACCESS_ALLOWED_GROUPS`: comma-separated browser-user groups.
- `ACCESS_ALLOWED_SERVICE_TOKENS`: comma-separated Service Token Client IDs, matched only against the validated JWT `common_name` claim.

Service Tokens are not authorized through browser-user email, subject, or group allowlists. The legacy refresh-secret fallback is disabled in production. Local authenticated verification uses `CF_ACCESS_CLIENT_SECRET` from `.dev.vars`; never commit or print that value.

## Factual verification API

Phase 1 was completed on July 17, 2026. It independently reads the City of Gulf Shores current-condition image, compares the published API result for Gulf Shores Public Beach, Gulf State Park Pavilion, and Little Lagoon Pass, and records freshness, provider-error, flag-color, and purple-advisory checks.

Protected routes:

```txt
POST /internal/verification/run
GET /internal/verification/latest
```

Both routes require the existing Cloudflare Access service token. Reports are stored in Workers KV as `verification:latest` and as dated records under `verification:report:YYYY-MM-DD:HH`. Dated reports expire after 30 days. `VerificationCoordinator` rejects a repeated Central-time hourly slot with HTTP `409`.

Cloudflare invokes an hourly UTC trigger. The Worker runs scheduled verification only at 7:00 AM and noon in `America/Chicago`, including daylight-saving transitions.

Deploy:

```sh
npx wrangler deploy
```

## Documentation

See `ARCHITECTURE.md` for the backend design, `DEVELOPMENT_LOG.md` for completed work, and `ROADMAP.md` for future phases.

## Tide predictions

`GET /v1/beach-conditions` may include an optional `tide` object on each beach. This is a backward-compatible addition and is omitted when NOAA data or defensible station coverage is unavailable.

```json
{
  "stationId": "8735180",
  "stationName": "Dauphin Island, AL",
  "stationType": "harmonic",
  "predictionDate": "2026-07-18",
  "timeZone": "America/Chicago",
  "datum": "MLLW",
  "units": "feet",
  "points": [{ "time": "2026-07-18T05:00:00.000Z", "height": 0.42 }],
  "events": [{ "type": "high", "time": "2026-07-18T16:15:00.000Z", "height": 1.08 }],
  "direction": "rising",
  "nextEvent": { "type": "high", "time": "2026-07-18T16:15:00.000Z", "height": 1.08 },
  "fetchedAt": "2026-07-18T12:00:00.000Z",
  "stationUrl": "https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=8735180"
}
```

Station coverage uses official NOAA prediction locations: Alabama Point `8730667` (harmonic) for the Orange Beach area; Gulf Shores ICWW `8731439` (harmonic) for Gulf Shores Public Beach and Gulf State Park; Mobile Point/Fort Morgan `8734635` (subordinate) for Fort Morgan; and Dauphin Island `8735180` (harmonic) for Dauphin Island. Little Lagoon Pass is intentionally unavailable pending defensible official coverage. Harmonic stations publish a direction only when NOAA returns actual interval predictions. Subordinate stations publish high/low predictions but are never used to infer an interval curve or direction.

## Project Status

The backend is production deployed and actively maintained. It serves as the central data platform for the Alabama Beach Flag iOS app and is designed to support future clients including widgets, the website, Android, and push notification services.
