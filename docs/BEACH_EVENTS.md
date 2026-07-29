# Beach Activity & Event Impact

## Purpose

This isolated domain answers whether a scheduled activity is physically happening at the exact beach being viewed and could affect parking, traffic, access, available beach space, or the choice of beach. It also permits useful exact-beach cleanup, wildlife, conservation, educational, and community activities. It is not a Gulf Shores or Orange Beach tourism calendar and does not describe live crowds or parking availability.

## Public and administrative interfaces

- `GET /v1/beach-events` serves the last successful published snapshot, grouped by canonical backend beach ID.
- `GET|POST /admin/beach-events` lists review data or creates a manual record.
- `PATCH|DELETE /admin/beach-events/:id` changes a local record or performs a guarded deletion.
- `POST /admin/beach-events/rules` creates a narrowly scoped decision-memory rule.
- `POST /admin/beach-events/exclusions/:id` assigns an excluded candidate to a canonical beach and creates a pending-review occurrence.
- `PATCH /admin/beach-events/notifications` updates the review-notification preferences.
- `POST /admin/beach-events/notifications/send` sends the current pending-review summary; `/test` verifies delivery without changing event state.
- `POST /internal/refresh/beach-events` performs an authenticated isolated refresh.

Imported source facts remain nested and unchanged while editable local fields control app presentation. Event states are draft, discovered, pending review, approved, scheduled, published, disregarded, cancelled, expired, and hidden.

## Exact-beach matching policy

`src/beachEvents/matching.ts` is the canonical mapping registry. A record must match an approved venue name, exact address alias, source-specific alias, or explicit administrator override. City names, island names, broad parks, generic beach words, proximity, and coordinates never create a match. Exclusion rules reject known inland or unrelated venues. Coordinates may validate a proposed mapping but are not stored as match rules. Every decision carries an explanation, confidence, source value, and rule identifier for administration.

Flora-Bama is unsupported. There is no intentional existing backend beach location for it; an explicit future product/location decision is required.

Dauphin Island West End Beach is also not represented by a distinct canonical backend beach ID. It remains an `exactBeachNotRepresented` candidate rather than being incorrectly attached to the public, Middle, or East End beaches.

## Types and impact

Event type and impact are independent. Types are festival, race or sport, beach cleanup, wildlife, conservation, educational, community, fireworks or holiday, access or parking impact, and other. Impacts are informational, noticeable, high, and major. Suggestions are review aids rather than factual claims.

## Provider catalog

| Provider | Exposure | Authority | Refresh | Status | Usage and attribution |
| --- | --- | --- | --- | --- | --- |
| City of Gulf Shores Special Events | Official CivicEngage iCalendar | City of Gulf Shores | Daily, 7:00 a.m. Central | Enabled | Normalize facts; retain only exact beach matches; display source and official link. |
| City of Orange Beach Parks and Recreation | Official CivicEngage iCalendar | City of Orange Beach | Daily, 7:00 a.m. Central | Enabled | Reject citywide/inland venues; display source and official link. |
| Orange Beach Coastal Resources | Official municipal iCalendar category 26 | City of Orange Beach | Daily, 7:00 a.m. Central | Enabled | The municipal iCalendar directory explicitly offers automatic calendar subscriptions. Match only exact supported beach access venues; keep attribution distinct from Parks and Recreation. |
| Gulf State Park Events | Public Google Calendar iCalendar embedded by the official park page | Alabama State Parks | Daily, 7:00 a.m. Central | Enabled | Match only Beach Pavilion aliases or another approved exact beach mapping. Nature Center, Learning Campus, campground, Lake Shelby, trail, and pier venues are excluded. Facts are bounded to the discovery window because the public calendar contains historical occurrences. |
| Town of Dauphin Island Events | Newest official monthly Town Crier PDF discovered from the Town newsletter archive | Town of Dauphin Island | Daily, 7:00 a.m. Central | Enabled | Extract conservative factual candidates from the newest issue, retain the issue month and PDF link, and match only exact represented beaches. The embedded calendar remains deferred and must not be requested until written access approval exists. |
| Dauphin Island Sea Lab | Official events web page | Dauphin Island Sea Lab | Manual | Manual-only | No verified structured public event feed was found. Campus, aquarium, lab, and boat events are excluded unless an administrator assigns a direct beach impact. |
| Alabama Coastal Cleanup | Official program website | Alabama Coastal Foundation / program partners | Manual | Manual-only | The site publishes annual dates and cleanup zones but no verified working structured event endpoint. Exact zone facts may be entered through review; do not scrape. |
| Alabama Audubon | Public Squarespace RSS/events collection | Alabama Audubon | None | Disabled / permission required | A technically accessible feed exists, but commercial-app reuse and automated retrieval intent are unclear. Broad Dauphin Island, Alabama coast, sanctuary, and historic-site locations do not match. |
| Fort Morgan official sources | Official public web announcements | Alabama Historical Commission and partners | Manual | Manual-only | No reliable structured beach-specific feed was found. Historic site, museum, ferry, and campground activity is not a Fort Morgan beach match. |
| Gulf Shores & Orange Beach Tourism Calendar | Website | Tourism organization | None | Disabled / permission required | No scraping, undocumented endpoint, copied description, image, logo, or deep link. |

Only factual title, venue, time, organizer, and official HTTPS link metadata is retained. Photographs, logos, and creative descriptions are not copied. Enabled providers' public-feed and caching notes are recorded in the Provider Catalog; feeds are fetched only on the daily refresh and the normalized public snapshot is bounded by the 12-hour stale policy.

## Refresh, failure, and stale behavior

The hourly Worker cron invokes this domain once when the local clock reaches 7:00 a.m. in `America/Chicago`, so daylight-saving transitions intentionally preserve the Central-Time wall clock. Provider observations flow to Provider Health. A provider failure cannot write beach-condition, flag, tide, weather, water-quality, or rip-current keys. Successful output is cached in `beach-events:v1:snapshot`; the public endpoint may serve that last-known-good snapshot for at most 12 hours and returns unavailable after the safe stale window.

Each attempt persists status at `beach-events:v1:refresh-status`, including trigger, timing, outcome, provider results, raw/matched/excluded/review/published counts, operational controls, snapshot timestamps, and the next scheduled refresh. The protected admin Source Refresh panel displays this record and may invoke `POST /internal/refresh/beach-events`; the endpoint rejects unauthenticated callers and duplicate attempts while a recent refresh is running. Manual attempts use the same ingestion path and write an administrative audit record.

Every saved public snapshot has a new `revision` and strong `ETag`. Clients may retain the representation, but they must revalidate it; a publish, edit, unpublish, cancellation, or expiration therefore becomes observable without retaining an old valid-but-empty response. The last-known-good safety bound remains 12 hours.

The admin response includes reusable `beachReferences` derived from `BeachRegistry`, exact venue mappings, and the event provider catalog. Addresses and aliases come only from approved matching configuration; coordinates and environmental sources come from `BeachRegistry`; event coverage and source URLs come from the provider catalog. Missing parking/access facts are stated as unavailable rather than inferred. This reference is read-only and remains separate from event `internalNotes`.

The current Dauphin Island app/backend model represents `dauphin-island-public-beach` (including the exact Middle Beach, Bienville Beach, and 1917 Bienville Boulevard aliases) and `dauphin-island-east-end`. West End Beach at 3000 Bienville Boulevard has no canonical beach ID and remains `exactBeachNotRepresented` with the explanation `Exact beach not represented in app`. Broad Dauphin Island, Town Hall, Community Center, Sea Lab, Alabama Aquarium, Fort Gaines, Audubon Bird Sanctuary, campground, marina, restaurant, gallery, inland-park, and islandwide locations never produce an automatic match. Unknown restaurants, galleries, and parks are excluded by the exact allowlist rather than inferred from category or proximity.

The official Town Crier newsletter archive is the primary and only active Dauphin Island event source. Each daily refresh discovers the newest month/year PDF link from the official archive, fetches that PDF with bounded response sizes, extracts its first full-page JPEG from the Town's image-only PDF encoding, converts that page through the configured Workers AI document-conversion binding, and extracts only calendar lines with explicit dates. General announcements, office information, advertisements, recaps, and undated prose do not become candidates. Duplicate title/date/time entries are collapsed, ended dates are omitted, missing location/contact/end-time facts remain absent, and events are sorted chronologically. An unsupported or changed PDF image encoding fails closed and preserves last-good data.

Town Crier facts flow through the same exact-beach matcher and pending-review workflow as every other provider. Broad Dauphin Island and inland venues remain excluded. The source month, official PDF URL, and note “Event information is sourced from the Town of Dauphin Island’s monthly Town Crier newsletter and may change after publication.” accompany matched events. Newsletter images, full articles, advertisements, and creative copy are not republished. Missing location, contact, or end-time facts remain absent and are never inferred. If archive discovery, PDF retrieval, or conversion fails, existing last-successful event records and the prior public snapshot remain intact; Provider Health and refresh observability report the failed/stale attempt, and a never-successful provider has no invented fallback data.

The former embedded Events Calendar source remains documented and structurally deferred rather than deleted. It must not be requested from production while its vendor terms prohibit automated access and systematic retrieval without written permission. If written permission is later obtained, provider dispatch can make the calendar primary without changing matching, review, attribution, snapshot, site, or iOS presentation layers.

The operational controls `domains.beachEvents`, `providers.gulfShoresEvents`, `providers.orangeBeachEvents`, `providers.gulfStateParkEvents`, and `providers.orangeBeachCoastalEvents` support enabled, disabled, and monitor-only states. Disabling this domain returns an empty disabled response without affecting other app data.

## Review notifications

Beach Activity Review Notifications use the existing production Worker email binding and the allowlisted recipients in `BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS`. `BEACH_ACTIVITY_NOTIFICATIONS_ENABLED` supplies the default master state; protected admin preferences can independently enable the daily reminder and immediate queue-change message and select a 15-minute Central-Time reminder boundary. The production default is 7:15 a.m. Central.

An immediate summary is evaluated after an import refresh and after an administrator creates, edits, deletes, or assigns an event. A stable revision of the pending event IDs and material review fields suppresses duplicate messages. The 15-minute scheduler evaluates the daily reminder in `America/Chicago`; a same-morning message for the same queue revision suppresses the reminder. Empty queues never produce review-summary email. Manual and test sends are explicit one-shot actions and never approve, publish, or otherwise mutate an event.

The summary contains limited factual metadata, high-impact-first ordering, official source links, and links to Review Events, Provider Health, and Operational Control. Delivery is attempted twice before a terminal failure. Configuration changes, sends, retry attempts, suppressions, disabled or monitor-only decisions, and failures are retained in the administrative audit history. Current queue revision, counts, last success/failure, provider error, and duplicate count are persisted for admin observability. Provider Health reports the internal `beach_activity_notifications` provider, while the `notifications.beachActivity` operational control can enable, disable, or monitor the subsystem without affecting beach-event ingestion or publication.

## Administration and decision memory

Administrators review source, venue, address, suggested beach, confidence, explanation, rule, type, impact, banner wording, recurrence, source link, notes, and similar decisions. Imported occurrences can be approved, edited, disregarded, cancelled, hidden, or published. Excluded and unsupported source facts are retained for 90 days in a separate administrative candidate index. Assigning a candidate or creating an exact venue/address alias never publishes it; the occurrence still enters pending review. Auto-approval requires an exact provider, exact venue, exact beach, and exact match confidence. Ignore rules may also include a title pattern. Every mutation writes an audit record.

Manual records require a canonical beach, valid time range, known type and impact, HTTPS official URL, banner wording, organizer/source, and publication state. A public submission never publishes directly. Trusted-organizer accounts and organizer access are future work.

## Legal and editorial notes

Store normalized facts and app-authored summaries. Do not claim a beach is packed, quiet, not crowded, or has parking available. Event details can change; users should confirm with the organizer. Source names and official HTTPS links remain visible.
