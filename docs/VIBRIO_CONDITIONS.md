# Vibrio Conditions prototype

## Architecture

`estimateVibrioConditions` is a pure function behind the deployment-level `VIBRIO_CONDITIONS_ENABLED` flag and the audited runtime control `domains.vibrioAwareness`. Production and staging explicitly enable the deployment-level flag. The runtime control can suppress only the seasonal awareness field without changing beach flags, water quality, weather, tides, or ordinary water temperature. When both controls are enabled, the existing 15-minute Beach Conditions refresh selects from a dedicated per-beach Vibrio allowlist and passes the normalized direct NOAA water-temperature observation into the estimator. The optional `vibrioConditions` member is omitted while either control is not enabled or when a beach is excluded by coverage policy.

The only Phase 1 statuses are `seasonalAwareness` and `unavailable`. May–October is educational CDC seasonal context, not an estimated bacterial level. Inputs older than the source-specific current-observation limit, more than ten minutes in the future, outside physical bounds (28–104 °F; 0–45 PSU), or missing produce `unavailable`. There is no climatology fallback. The response carries both observation and generation timestamps. Public HTTP caching is limited to five minutes; the upstream payload refreshes every 15 minutes and expires from KV after two hours.

The prototype reuses the current provider boundary (`coops`/`ndbc`). A dedicated live Vibrio provider should remain protocol-based if future inputs differ. `docs/VibrioConditionsPrototype.swift` is a dependency-free SwiftUI integration reference because this repository contains the Worker API, not the Alabama Beach Flag Xcode project.

### Direct-observation selection

General temperature and Vibrio have separate ordered `BeachRegistry` allowlists. Selection walks the relevant list and returns the first successfully parsed direct NOAA observation within the same two-hour freshness window used by Vibrio. Thus, when multiple approved observations are fresh, configured geographic preference wins deterministically. A stale or unparseable candidate does not stop fallback. If every approved candidate is stale or unavailable, the general temperature tile retains the first successfully parsed observation for compatibility, while Vibrio independently fails closed with `unavailable`. A shared provider/station request cache prevents duplicate NOAA requests across both policies.

## Data sources and geographic mapping

All values currently used are direct observations, never forecasts or model guidance.

Audit findings implemented and re-reviewed **July 30, 2026** using the official NDBC station pages, NDBC realtime text feeds, and NOAA CO-OPS Data API. The iOS copy follows the current CDC wound, seafood, emergency-care, and higher-risk wording. This implementation does not claim endorsement by CDC, ADPH, NOAA, or Dauphin Island Sea Lab.

| Beach | Vibrio eligibility and approved station order | Mapping caveat |
|---|---|---|
| Alabama Point | Eligible: NDBC PPTA1 | Station is about 0.2 mi away in Perdido Pass; it is an inlet proxy, not a beach measurement. |
| Cotton Bayou | Eligible: NDBC PPTA1 | Station is about 0.3 mi away in Perdido Pass; it is an inlet proxy, not a beach measurement. |
| Gulf Shores Public Beach | Eligible: NDBC PPTA1 | Station is about 7.9 mi away in Perdido Pass; it is an inlet proxy, not a Gulf Shores beach measurement. |
| Gulf State Park Pavilion | **Excluded** pending validation | Corrected mapping coordinate is documented below, but proxy representativeness still requires NOAA/Sea Lab review. |
| Little Lagoon Pass | **Excluded** | A lagoon/pass environment without a validated approved direct-observation proxy. |
| Florida Point | Eligible: NDBC PPTA1 | Station is about 0.5 mi away in the same pass; it remains a point observation. |
| Fort Morgan Public Beach | Eligible: NDBC 42357, NDBC DPHA1, CO-OPS 8735180 | 42357 is a Gulf-facing direct observation about 14.7 mi away and therefore precedes the closer but Mobile Bay-entrance stations (about 3.5/3.3 mi). |
| Dauphin Island Public Beach | Eligible: CO-OPS 8735180, NDBC DPHA1, NDBC 42357 | East-end stations about 2 mi away precede the Gulf-facing 42357 fallback about 12.5 mi away. |
| Dauphin Island East End | Eligible: NDBC DPHA1, CO-OPS 8735180, NDBC 42357 | The first two stations are effectively colocated at the east end; Gulf-facing 42357 is a lower-priority fallback about 13.7 mi away. |

CO-OPS 8735180 was removed from the eastern-beach Vibrio lists: at roughly 23–32 mi away and across Mobile Bay/entrance geography, it is not a defensible fallback merely because it is fresh. It remains approved for Fort Morgan and Dauphin Island. NDBC 42012 remains available to ordinary water temperature but is excluded from every Vibrio list because NOAA identifies it as an offshore buoy 44 nautical miles southeast of Mobile. Geographic proximity alone does not override environment.

### Station evidence and freshness

| Station | Official station context | Live reporting observed July 30, 2026 | Vibrio policy |
|---|---|---|---|
| NDBC 42357 | DISL Sofar Spotter, 30.092 N, 88.212 W; Gulf-facing nearshore observation. NDBC does not publish a sensor depth on the station page. | Records every 30 minutes; `WTMP` appeared about hourly. | Fresh through 120 min; unavailable after 240 min. Fort Morgan primary; lower-priority Dauphin Island fallback. |
| NDBC 42012 | “ORANGE BEACH - 44 NM SE of Mobile, AL,” 30.061 N, 87.547 W; offshore buoy. Registry metadata records a 0.6 m sensor depth. | Ten-minute records with direct `WTMP`. | Fresh through 60 min; unavailable after 180 min. General temperature only. |
| NDBC PPTA1 | DISL water-quality station at Perdido Pass, 30.279 N, 87.556 W; sea-temperature sensor 1.3 m below MLLW. | Hourly records with direct `WTMP`. | Fresh through 90 min; unavailable after 180 min. Approved for the four eastern beaches only. |
| NDBC DPHA1 | DISL coastal marine station at the Dauphin Island/Mobile Bay entrance, 30.251 N, 88.078 W; sensor 2.1 m below MLLW. | Hourly records with direct `WTMP`. | Fresh through 90 min; unavailable after 180 min. Western fallback/primary only. |
| CO-OPS 8735180 | Dauphin Island, 30.250 N, 88.075 W; direct CO-OPS water-temperature product. Published sensor depth was not established in this audit. | Latest API value at six-minute cadence; `date=latest` returns a point from the preceding 18 minutes. | Fresh through 30 min; unavailable after 90 min. Western fallback/primary only. |

### Gulf State Park Pavilion coordinate correction

- Official facility address: **22250 East Beach Blvd, Gulf Shores, AL 36542**, published by [Alabama State Parks](https://www.alapark.com/parks/gulf-state-park/beaches).
- Previous duplicated coordinate: **30.2499, -87.6847** (the Gulf Shores Public Beach coordinate).
- Dedicated Vibrio mapping coordinate: **30.25517036, -87.64240986**, from federal [Geographic Response Plan site AL-25, Gulfshores State Park](https://www.glo.texas.gov/sites/default/files/documents/ost/responsemaps/mississippi/grpms/maps/AL-25.pdf), which identifies the same physical address. This is deliberately stored separately; shared `location` and `weather` coordinates remain unchanged.
- Approximate straight-line distances using official station coordinates: PPTA1 **5.4 mi**; DPHA1 **26.0 mi**; CO-OPS 8735180 **25.9 mi**.
- Recommendation: continue exclusion until a NOAA/Sea Lab reviewer validates whether PPTA1/Perdido Pass is hydrologically representative enough for Pavilion use. Coordinate correction alone is not treated as station approval.

- NDBC: stable machine-readable `https://www.ndbc.noaa.gov/data/realtime2/{station}.txt`; standard meteorological records are generally hourly. Station availability and sensor reporting can change without a versioned schema guarantee.
- NOAA CO-OPS: supported Data API `datagetter`, `product=water_temperature`, `date=latest`, JSON. NOAA defines `latest` as the most recent point within 18 minutes and meteorological observations default to six-minute intervals. The current station is 8735180 (Dauphin Island). This is a measured observation.
- Freshness policy is station-specific and cadence-based as listed above, with ten minutes of future clock-skew tolerance. The Vibrio selector accepts only `current`, never `stale`, observations. Keep the visible `dataTimestamp`; a missing current value is `unavailable`.
- Salinity: omitted. Although CO-OPS supports salinity as a product, no currently configured source has been established as a reliable, geographically representative salinity observation for every supported beach. Do not infer it from waterbody, temperature, a distant bay station, or climatology.
- Endpoint stability: CO-OPS Data API is the preferred documented service. NDBC realtime text is already in production use but is a flat-file format, so parsers must continue to fail closed on header/schema changes.

Official references: [NOAA CO-OPS Data API](https://api.tidesandcurrents.noaa.gov/api/prod/), [NOAA response fields](https://api.tidesandcurrents.noaa.gov/api/prod/responseHelp.html), [NOAA web services](https://www.tidesandcurrents.noaa.gov/web_services_info.html), [CDC prevention](https://www.cdc.gov/vibrio/prevention/index.html), [CDC oysters](https://www.cdc.gov/vibrio/prevention/vibrio-and-oysters.html), and [ADPH shellfish program](https://www.alabamapublichealth.gov/environmental/shellfish.html).

## Product limitations

The name is “Vibrio Conditions.” It does not test water, establish that Vibrio is present or absent, predict infection or personal medical risk, or say whether swimming is safe. Temperature is displayed only as provenance-bearing environmental context. Official closures, advisories, beach flags, rip-current warnings, and weather alerts must remain above this secondary card.

The NOAA Northern Gulf oyster-harvest *V. parahaemolyticus* forecast and Chesapeake Bay *V. vulnificus* probability model are explicitly excluded: neither is validated here for Alabama recreational-water or wound-infection use. A temperature threshold or “low/moderate/high” level would also be misleading and is out of scope.

## Release decision for 1.3.0

1. Integrate and test the SwiftUI reference in the actual iOS repository, below all primary safety information, including VoiceOver, Dynamic Type, localization, and offline states.
2. Use the current exact CDC prevention wording and link to current ADPH/CDC resources. Changes to medical guidance require a new public-health review.
3. Maintain a documented, owner-approved contextual-station policy. External scientific review remains required before creating a predictive model or expanding the two excluded locations.
4. Production monitoring for station/schema changes, clock skew, freshness failures, and cache age.
5. Legal/editorial review of external links and health disclaimer; analytics must not describe the status as “risk.”
6. Decide whether off-season should show an unavailable card or hide the feature; never label off-season “safe” or “low.”
7. Preserve app regression coverage, API contract fixtures, deterministic fallback tests, and fail-closed behavior.

## Production-readiness decision (July 30, 2026)

The product owner approved production enablement as a **seasonal safety-awareness feature**, not a Vibrio prediction model. The decision accepts the documented contextual-station limitations for the eligible beaches while keeping Gulf State Park Pavilion and Little Lagoon Pass excluded. Exact CDC wording, direct observations, source-specific freshness, deterministic fallback, and fail-closed behavior remain mandatory. Any future rainfall/salinity-based risk model or expansion of excluded locations still requires qualified external scientific review.

Production has two independent safeguards:

1. `VIBRIO_CONDITIONS_ENABLED` is the deployment-level master flag.
2. `domains.vibrioAwareness` is the Cloudflare Access-protected runtime kill switch in Operational Control.

`disabled` and `monitorOnly` both suppress `vibrioConditions` from public Beach Conditions responses. Every transition requires a reason, expiry policy, revision match, explicit confirmation, and an immutable audit record. Restoring the control does not certify cached data as current; verify a fresh Beach Conditions refresh after restoration.

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

Refresh diagnostics log only non-sensitive operational fields such as `beachId`, `scope`, `condition`, `provider`, and `stationId`. Conditions distinguish coverage-policy exclusion, no approved station/observation, missing temperature, stale, future-dated, physically invalid observations, NDBC parser/reporting failure, CO-OPS HTTP failure, and other parser failures. Internal diagnostic codes are stripped from public responses. Response bodies, credentials, and personal information are not logged.

### Isolated staging

The checked-in `wrangler.staging.jsonc` deploys only `alabamabeachflag-api-staging` at `https://alabamabeachflag-api-staging.sparkelectricalservicesllc.workers.dev`. It binds the isolated `ALABAMA_BEACH_FLAG_STAGING_CACHE` KV namespace, uses Worker-scoped Durable Object state, and has an isolated 15-minute refresh trigger. Its Vibrio deployment flag and runtime control are independent of production.

Cloudflare Access protects exactly the staging `/internal/*` path. The `Staging Refresh Service Token` service-auth policy admits only the `alabamabeachflag-api-staging-refresh` service token; the Worker then verifies the signed Access assertion's issuer, audience, and allowlisted client ID. Keep the client secret in an ignored, mode-600 `.env.staging` file using `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. Never add the secret to Wrangler configuration, documentation, source control, or shell tracing.

Deploy or update staging only with:

```sh
npx wrangler deploy --config wrangler.staging.jsonc
```

After deployment, populate staging by sending authenticated `POST` requests to `/internal/refresh/beach-flags` and `/internal/refresh/beach-conditions`, each with a unique `Idempotency-Key`. Supply `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers from `.env.staging`; do not print them. Public results are available at `/v1/beach-flags` and `/v1/beach-conditions`.

To turn seasonal awareness off without deployment, disable `domains.vibrioAwareness` in the protected Operational Control console and confirm every `vibrioConditions` field is absent while unrelated conditions remain populated. The deployment-level emergency fallback remains changing `VIBRIO_CONDITIONS_ENABLED` to `false` and deploying the intended environment.

Cloudflare bindings and variables are non-inheritable across environments, so staging must explicitly use its own KV and variables. A separately named Worker keeps its Durable Object state separate as well. See Cloudflare's current [environment documentation](https://developers.cloudflare.com/workers/wrangler/environments/).
