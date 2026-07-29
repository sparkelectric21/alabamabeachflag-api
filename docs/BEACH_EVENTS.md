# Beach Activity & Event Impact

## Purpose

This isolated domain answers whether a scheduled activity is physically happening at the exact beach being viewed and could affect parking, traffic, access, available beach space, or the choice of beach. It also permits useful exact-beach cleanup, wildlife, conservation, educational, and community activities. It is not a Gulf Shores or Orange Beach tourism calendar and does not describe live crowds or parking availability.

## Public and administrative interfaces

- `GET /v1/beach-events` serves the last successful published snapshot, grouped by canonical backend beach ID.
- `GET|POST /admin/beach-events` lists review data or creates a manual record.
- `PATCH|DELETE /admin/beach-events/:id` changes a local record or performs a guarded deletion.
- `POST /admin/beach-events/rules` creates a narrowly scoped decision-memory rule.
- `POST /internal/refresh/beach-events` performs an authenticated isolated refresh.

Imported source facts remain nested and unchanged while editable local fields control app presentation. Event states are draft, discovered, pending review, approved, scheduled, published, disregarded, cancelled, expired, and hidden.

## Exact-beach matching policy

`src/beachEvents/matching.ts` is the canonical mapping registry. A record must match an approved venue name, exact address alias, source-specific alias, or explicit administrator override. City names, proximity, and coordinates never create a match. Exclusion rules reject known inland or unrelated venues. Coordinates may validate a proposed mapping but are not stored as match rules.

Flora-Bama is unsupported. There is no intentional existing backend beach location for it; an explicit future product/location decision is required.

## Types and impact

Event type and impact are independent. Types are festival, race or sport, beach cleanup, wildlife, conservation, educational, community, fireworks or holiday, access or parking impact, and other. Impacts are informational, noticeable, high, and major. Suggestions are review aids rather than factual claims.

## Provider catalog

| Provider | Exposure | Authority | Refresh | Status | Usage and attribution |
| --- | --- | --- | --- | --- | --- |
| City of Gulf Shores Special Events | Official CivicEngage iCalendar | City of Gulf Shores | Daily, 7:00 a.m. Central | Enabled | Normalize facts; retain only exact beach matches; display source and official link. |
| City of Orange Beach Parks and Recreation | Official CivicEngage iCalendar | City of Orange Beach | Daily, 7:00 a.m. Central | Enabled | Reject citywide/inland venues; display source and official link. |
| Gulf State Park Activities Calendar | Embedded calendar | Alabama State Parks | None | Disabled | No verified structured public feed; brittle scraping prohibited. |
| Gulf Shores & Orange Beach Tourism Calendar | Website | Tourism organization | None | Disabled / permission required | No scraping, undocumented endpoint, copied description, image, logo, or deep link. |

Alabama Coastal Cleanup, Orange Beach Coastal Resources, Alabama Audubon, Dauphin Island Sea Lab, and other official conservation sources are future opportunities after a structured-feed and usage review. Adapter support should be added before enabling them.

## Refresh, failure, and stale behavior

The hourly Worker cron invokes this domain once when the local clock reaches 7:00 a.m. in `America/Chicago`, so daylight-saving transitions intentionally preserve the Central-Time wall clock. Provider observations flow to Provider Health. A provider failure cannot write beach-condition, flag, tide, weather, water-quality, or rip-current keys. Successful output is cached in `beach-events:v1:snapshot`; the public endpoint may serve that last-known-good snapshot for at most 12 hours and returns unavailable after the safe stale window.

Each attempt persists status at `beach-events:v1:refresh-status`, including trigger, timing, outcome, provider results, raw/matched/excluded/review/published counts, operational controls, snapshot timestamps, and the next scheduled refresh. The protected admin Source Refresh panel displays this record and may invoke `POST /internal/refresh/beach-events`; the endpoint rejects unauthenticated callers and duplicate attempts while a recent refresh is running. Manual attempts use the same ingestion path and write an administrative audit record.

The operational controls `domains.beachEvents`, `providers.gulfShoresEvents`, and `providers.orangeBeachEvents` support enabled, disabled, and monitor-only states. Disabling this domain returns an empty disabled response without affecting other app data.

## Administration and decision memory

Administrators review source, venue, address, suggested beach, confidence, type, impact, banner wording, recurrence, source link, notes, and similar decisions. Imported occurrences can be approved, edited, disregarded, cancelled, hidden, or published. Auto-approval requires an exact provider, exact venue, exact beach, and exact match confidence. Ignore rules may also include a title pattern. Every mutation writes an audit record.

Manual records require a canonical beach, valid time range, known type and impact, HTTPS official URL, banner wording, organizer/source, and publication state. A public submission never publishes directly. Trusted-organizer accounts and organizer access are future work.

## Legal and editorial notes

Store normalized facts and app-authored summaries. Do not claim a beach is packed, quiet, not crowded, or has parking available. Event details can change; users should confirm with the organizer. Source names and official HTTPS links remain visible.
