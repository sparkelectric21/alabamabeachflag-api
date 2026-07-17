# Vibrio Conditions prototype

## Architecture

`estimateVibrioConditions` is a pure function behind `VIBRIO_CONDITIONS_ENABLED`. The variable is intentionally absent from the production `wrangler.jsonc`, so the feature defaults off. It is enabled only by a local `.dev.vars` file or the separate staging configuration created from the checked-in example. When enabled, the existing 15-minute Beach Conditions refresh passes each beach's already-normalized direct NOAA water-temperature observation into the estimator. The optional `vibrioConditions` member is omitted entirely while disabled, preserving the current API contract.

The only Phase 1 statuses are `seasonalAwareness` and `unavailable`. May–October is educational CDC seasonal context, not an estimated bacterial level. Inputs older than two hours, more than ten minutes in the future, outside physical bounds (28–104 °F; 0–45 PSU), or missing produce `unavailable`. There is no climatology fallback. The response carries both observation and generation timestamps. Public HTTP caching is limited to five minutes; the upstream payload refreshes every 15 minutes and expires from KV after two hours. Existing cached data makes brief source outages non-fatal without allowing an indefinitely stale payload to look current.

The prototype reuses the current provider boundary (`coops`/`ndbc`). A dedicated live Vibrio provider should remain protocol-based if future inputs differ. `docs/VibrioConditionsPrototype.swift` is a dependency-free SwiftUI integration reference because this repository contains the Worker API, not the Alabama Beach Flag Xcode project.

### Direct-observation selection

Water-temperature sources remain restricted to each beach's ordered `BeachRegistry` allowlist. Selection walks that list in order and returns the first successfully parsed direct NOAA observation within the same two-hour freshness window used by Vibrio. Thus, when multiple approved observations are fresh, configured geographic preference wins deterministically. A stale or unparseable candidate does not stop fallback. If every approved candidate is stale or unavailable, the general temperature tile retains the first successfully parsed observation for compatibility, while Vibrio independently fails closed with `unavailable`. Requests are cached by provider and station so shared candidates are fetched once per refresh.

## Data sources and geographic mapping

All values currently used are direct observations, never forecasts or model guidance.

| Beaches | Preferred station(s), in existing order | Mapping caveat |
|---|---|---|
| Gulf Shores Public Beach, Gulf State Park Pavilion, Little Lagoon Pass | NDBC BSCA1, NDBC PPTA1, CO-OPS 8735180 | Nearby coastal observations, not measurements at the named beach. |
| Alabama Point, Cotton Bayou, Florida Point | NDBC PPTA1, CO-OPS 8735180 | Perdido Pass/nearby coastal proxy; spatial differences are possible. |
| Fort Morgan Public Beach | NDBC DPHA1, CO-OPS 8735180, NDBC PPTA1 | Mobile Bay/Dauphin Island proxy; not a Fort Morgan beach measurement. |
| Dauphin Island Public Beach | CO-OPS 8735180, NDBC DPHA1 | Mobile Bay/Dauphin Island proxy. |
| Dauphin Island East End | NDBC DPHA1, CO-OPS 8735180 | DPHA1 is the closest configured direct observation. |

- NDBC: stable machine-readable `https://www.ndbc.noaa.gov/data/realtime2/{station}.txt`; standard meteorological records are generally hourly. Station availability and sensor reporting can change without a versioned schema guarantee.
- NOAA CO-OPS: supported Data API `datagetter`, `product=water_temperature`, `date=latest`, JSON. NOAA defines `latest` as the most recent point within 18 minutes and meteorological observations default to six-minute intervals. The current station is 8735180 (Dauphin Island). This is a measured observation.
- Freshness policy: accept at most two hours old with ten minutes of future clock-skew tolerance. Keep the visible `dataTimestamp`. A missing current value is `unavailable`.
- Salinity: omitted. Although CO-OPS supports salinity as a product, no currently configured source has been established as a reliable, geographically representative salinity observation for every supported beach. Do not infer it from waterbody, temperature, a distant bay station, or climatology.
- Endpoint stability: CO-OPS Data API is the preferred documented service. NDBC realtime text is already in production use but is a flat-file format, so parsers must continue to fail closed on header/schema changes.

Official references: [NOAA CO-OPS Data API](https://api.tidesandcurrents.noaa.gov/api/prod/), [NOAA response fields](https://api.tidesandcurrents.noaa.gov/api/prod/responseHelp.html), [NOAA web services](https://www.tidesandcurrents.noaa.gov/web_services_info.html), [CDC prevention](https://www.cdc.gov/vibrio/prevention/index.html), [CDC oysters](https://www.cdc.gov/vibrio/prevention/vibrio-and-oysters.html), and [ADPH shellfish program](https://www.alabamapublichealth.gov/environmental/shellfish.html).

## Product limitations

The name is “Vibrio Conditions.” It does not test water, establish that Vibrio is present or absent, predict infection or personal medical risk, or say whether swimming is safe. Temperature is displayed only as provenance-bearing environmental context. Official closures, advisories, beach flags, rip-current warnings, and weather alerts must remain above this secondary card.

The NOAA Northern Gulf oyster-harvest *V. parahaemolyticus* forecast and Chesapeake Bay *V. vulnificus* probability model are explicitly excluded: neither is validated here for Alabama recreational-water or wound-infection use. A temperature threshold or “low/moderate/high” level would also be misleading and is out of scope.

## Release gates for 1.3.0

1. Integrate and test the SwiftUI reference in the actual iOS repository, below all primary safety information, including VoiceOver, Dynamic Type, localization, and offline states.
2. Public-health review by ADPH/CDC-qualified subject-matter reviewers of naming, May–October framing, one-minute copy, and medical guidance.
3. NOAA station-owner confirmation and a documented per-beach spatial representativeness review; reconsider beaches whose nearest proxy is too remote or hydrologically different.
4. Production monitoring for station/schema changes, clock skew, freshness failures, and cache age.
5. Legal/editorial review of external links and health disclaimer; analytics must not describe the status as “risk.”
6. Decide whether off-season should show an unavailable card or hide the feature; never label off-season “safe” or “low.”
7. Add app-repository snapshot/UI tests and API contract fixtures before enabling the flag in any environment.

## Recommendation

Ready for **internal testing only**, with fixture or existing observed-temperature data and the flag restricted to internal builds. It is not ready for an educational-only public release until the public-health, geographic-mapping, accessibility, and client integration gates above are complete. Live estimated levels should remain reserved until a Gulf-specific recreational-water method is validated and reviewed.

## Internal QA runbook

### Local (no Cloudflare changes)

```sh
cp .dev.vars.example .dev.vars
npm ci
npx wrangler dev src/local.ts --local
```

Wrangler starts at `http://127.0.0.1:8787`. The `src/local.ts` entrypoint is required for fixtures; the production entrypoint does not read `VIBRIO_QA_FIXTURE`. Refresh and inspect with:

```sh
curl -sS -X POST http://127.0.0.1:8787/__local/refresh/beach-conditions
curl -sS http://127.0.0.1:8787/v1/beach-flags
curl -sS http://127.0.0.1:8787/v1/beach-conditions
```

`vibrioConditions` is attached to items in `/v1/beach-conditions`; `/v1/beach-flags` remains authoritative and independent. To disable immediately, set the local variable to `false` (or remove it), stop Wrangler, remove `.wrangler/state` only if the local cached enabled payload must be discarded, and restart. Never add the variable to production `wrangler.jsonc`.

Local fixture modes in `.dev.vars` are:

```text
# Successful UI
VIBRIO_CONDITIONS_ENABLED="true"
VIBRIO_QA_FIXTURE="seasonalAwareness"

# Unavailable UI
VIBRIO_QA_FIXTURE="unavailable"

# Genuine NOAA behavior
# Remove or comment out VIBRIO_QA_FIXTURE.
```

Restart Wrangler after every `.dev.vars` change. If a previous local result remains cached, stop Wrangler and remove only this repository's `.wrangler/state` directory, never a parent directory or Cloudflare resource, then restart and invoke the local refresh endpoint again.

The fixture affects only `vibrioConditions`; ordinary weather and NOAA water-temperature fields are still fetched and preserved. Fixture code is outside the production/staging entrypoint, and its refresh route additionally accepts only loopback request hosts. Deployed traffic therefore receives no fixture route even if someone mistakenly creates a similarly named variable or selects the local entrypoint. Unknown, empty, or malformed fixture values use genuine NOAA behavior.

Refresh diagnostics log only `beachId`, `condition`, `provider`, and `stationId`. Conditions include missing, stale, future-dated, invalid-temperature, invalid-salinity, and parser failures. Response bodies, credentials, and personal information are not logged.

### Staging (Cloudflare approval required)

`wrangler.staging.example.jsonc` deliberately contains placeholders and cannot be deployed as-is. It uses a distinct Worker name, requires a distinct KV namespace, receives its own Worker-scoped Durable Object storage, has no cron triggers, and enables Vibrio only in staging.

After approval, a Cloudflare administrator should run:

```sh
npx wrangler kv namespace create BEACH_DATA --config wrangler.staging.example.jsonc
cp wrangler.staging.example.jsonc wrangler.staging.jsonc
```

Replace `REPLACE_WITH_STAGING_KV_NAMESPACE_ID` with the returned ID and `REPLACE_WITH_STAGING_WORKER_HOST` with the staging `*.workers.dev` host. Configure staging-only secrets with `npx wrangler secret put NAME --config wrangler.staging.jsonc`; do not reuse production credentials without explicit upstream-owner approval. Validate with `npx wrangler types --config wrangler.staging.jsonc`. Only after separate deployment authorization, deploy with:

```sh
npx wrangler deploy --config wrangler.staging.jsonc
```

To turn staging Vibrio off, change only the staging value to `false`, deploy a new staging version, and refresh Beach Conditions. The fastest dashboard kill switch is also staging-only; sync any dashboard change back into `wrangler.staging.jsonc` before the next CLI deployment. Do not change production.

Cloudflare bindings and variables are non-inheritable across environments, so staging must explicitly use its own KV and variables. A separately named Worker keeps its Durable Object state separate as well. See Cloudflare's current [environment documentation](https://developers.cloudflare.com/workers/wrangler/environments/).
