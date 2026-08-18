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
- `POST /internal/refresh/beach-events/provider` performs an authenticated refresh of exactly one enabled automated provider. Its JSON body is `{"providerId":"gulfStatePark"}`. IDs are matched exactly against the server-side registry; URLs, multiple providers, disabled providers, and manual-only providers are rejected before a run is created.

The provider-scoped staging route remains disabled unless `STAGING_LIVE_PROVIDER_FETCH_ENABLED=true`; invoking it makes a live upstream request. Scoped runs share the normal lock, conditional-fetch, quality, lifecycle, and provider-health safeguards. They never treat unselected providers as absent, and any public snapshot is rebuilt from the complete stored eligible event set. The existing `/internal/refresh/beach-events` endpoint remains the explicit all-provider operation.

iCalendar components are quarantined individually. An observation with at most five rejected components and no more than a one-percent rejected-component ratio is recorded as `quarantined`: valid components may update the full stored-event snapshot and provider health remains successful, but source-absence reconciliation stays disabled. Larger non-fatal rejection ratios remain `partial`, preserve the last public snapshot, and degrade provider health; the existing five-percent quality gate still fails closed.

The latest normalized source facts remain nested for traceability while editable local fields control app presentation. When a source revision is material, the previously reviewed facts are retained in `sourceChange` and in the audit record. Event states are draft, discovered, pending review, approved, scheduled, published, disregarded, cancelled, expired, and hidden. Flags such as material source change, ambiguous match, possible duplicate, source missing/removed/restored, and normalization warning add attention without creating redundant states.

## Exact-beach matching policy

`src/beachEvents/matching.ts` is the canonical mapping registry. A record must match an approved venue name, exact address alias, source-specific alias, or explicit administrator override. City names, island names, broad parks, generic beach words, proximity, and coordinates never create a match. Exclusion rules reject known inland or unrelated venues. Coordinates may validate a proposed mapping but are not stored as match rules. Every decision carries an explanation, confidence, source value, and rule identifier for administration.

Flora-Bama is outside the supported Alabama beach destinations and remains excluded. It is not a canonical beach, venue alias, or candidate for automatic assignment in this feature.

West End Beach is a named destination within the app's broad Dauphin Island experience, not a separate top-level app beach. Exact `West End Beach` venue and 3000 Bienville Boulevard aliases map to the existing `dauphin-island-public-beach` API ID while the event retains `West End Beach` as its public venue. This alias does not enable any Dauphin Island provider or bypass manual review.

## Types and impact

Event type and impact are independent. Types are festival, race or sport, beach cleanup, wildlife, conservation, educational, community, fireworks or holiday, access or parking impact, and other. Impacts are informational, noticeable, high, and major. Suggestions are review aids rather than factual claims.

## Provider catalog

| Provider | Exposure | Authority | Refresh | Status | Usage and attribution |
| --- | --- | --- | --- | --- | --- |
| City of Gulf Shores Special Events | Official CivicEngage iCalendar | City of Gulf Shores | Daily, 7:00 a.m. Central | Enabled | Normalize facts; retain only exact beach matches; display source and official link. |
| City of Orange Beach Parks and Recreation | Official CivicEngage iCalendar | City of Orange Beach | Daily, 7:00 a.m. Central | Enabled | Reject citywide/inland venues; display source and official link. |
| Orange Beach Coastal Resources | Official municipal iCalendar category 26 | City of Orange Beach | Daily, 7:00 a.m. Central | Enabled | The municipal iCalendar directory explicitly offers automatic calendar subscriptions. Match only exact supported beach access venues; keep attribution distinct from Parks and Recreation. |
| Gulf State Park Events | Public Google Calendar iCalendar embedded by the official park page | Alabama State Parks | Daily, 7:00 a.m. Central | Enabled | Match Beach Pavilion and narrowly approved official Pier aliases to the Pavilion beach record. Nature Center, Learning Campus, campground, Lake Shelby, and trail venues are excluded. Facts are bounded to the discovery window because the public calendar contains historical occurrences. |
| Town of Dauphin Island Events | Official Town calendar page | Town of Dauphin Island | None | Disabled / permission required | Do not automate the embedded calendar or Town event retrieval. Enter relevant events manually, retain an official Town link, and assign only an exact represented beach. |
| Dauphin Island Sea Lab | Official events web page | Dauphin Island Sea Lab | Manual | Manual-only | No verified structured public event feed was found. Campus, aquarium, lab, and boat events are excluded unless an administrator assigns a direct beach impact. |
| Alabama Coastal Cleanup | Official program website | Alabama Coastal Foundation / program partners | Manual | Manual-only | The site publishes annual dates and cleanup zones but no verified working structured event endpoint. Exact zone facts may be entered through review; do not scrape. |
| Alabama Audubon | Public Squarespace RSS/events collection | Alabama Audubon | None | Disabled / permission required | A technically accessible feed exists, but commercial-app reuse and automated retrieval intent are unclear. Broad Dauphin Island, Alabama coast, sanctuary, and historic-site locations do not match. |
| Fort Morgan official sources | Official public web announcements | Alabama Historical Commission and partners | Manual | Manual-only | No reliable structured beach-specific feed was found. Historic site, museum, ferry, and campground activity is not a Fort Morgan beach match. |
| Gulf Shores & Orange Beach Tourism Calendar | Website | Tourism organization | None | Disabled / permission required | No scraping, undocumented endpoint, copied description, image, logo, or deep link. |

Normalized title, venue, time, organizer, and official HTTPS link metadata drives the event record. Imported descriptions are retained only in protected source facts for normalization, change comparison, and review; only sanitized text is eligible for public serialization. Photographs and logos are not copied. Enabled providers' public-feed and caching notes are recorded in the Provider Catalog; feeds are fetched only on the daily refresh and the normalized public snapshot is bounded by the 12-hour stale policy.

## Refresh, failure, and stale behavior

The hourly Worker cron invokes this domain once when the local clock reaches 7:00 a.m. in `America/Chicago`, so daylight-saving transitions intentionally preserve the Central-Time wall clock. Provider observations flow to Provider Health. A provider failure cannot write beach-condition, flag, tide, weather, water-quality, or rip-current keys. Successful output is cached in `beach-events:v1:snapshot`; the public endpoint may serve that last-known-good snapshot for at most 12 hours and returns unavailable after the safe stale window.

Each attempt persists status at `beach-events:v1:refresh-status`, including trigger, last attempt/success/failure, provider results, scanned/new/changed/unchanged/matched/rejected/review/duplicate/warning/source-missing counts, operational controls, whether the public revision changed, snapshot timestamps, and the next scheduled refresh. The protected admin Source Refresh panel displays this record and may invoke `POST /internal/refresh/beach-events`; the endpoint rejects unauthenticated callers and duplicate attempts while a recent refresh is running. Manual attempts use the same ingestion path and write an administrative audit record.

The public snapshot revision is a deterministic hash of its allowlisted event content and attribution. An unchanged refresh keeps the same public revision; a public publish, edit, unpublish, cancellation, or expiration changes it. The HTTP `ETag` also incorporates the last-successful-refresh timestamp so revalidation reflects the complete response representation. The last-known-good safety bound remains 12 hours.

The admin response includes reusable `beachReferences` derived from `BeachRegistry`, exact venue mappings, and the event provider catalog. Addresses and aliases come only from approved matching configuration; coordinates and environmental sources come from `BeachRegistry`; event coverage and source URLs come from the provider catalog. Missing parking/access facts are stated as unavailable rather than inferred. This reference is read-only and remains separate from event `internalNotes`.

The current Dauphin Island app/backend model represents `dauphin-island-public-beach` and `dauphin-island-east-end`. The iOS contract groups both under its Dauphin Island destination and uses `dauphin-island-public-beach` as that destination's primary backend ID. Middle Beach, Bienville Beach, West End Beach, and their reviewed exact addresses map to `dauphin-island-public-beach`; East End remains separate. Broad Dauphin Island, Town Hall, Community Center, Sea Lab, Alabama Aquarium, Fort Gaines, Audubon Bird Sanctuary, campground, marina, restaurant, gallery, inland-park, and islandwide locations never produce an automatic match. Unknown restaurants, galleries, and parks are excluded by the exact allowlist rather than inferred from category or proximity.

Dauphin Island automation is disabled. The embedded Events Calendar vendor terms prohibit automated access and systematic retrieval without written permission, so neither that calendar nor the Town Crier archive is fetched by the production event refresh. Existing manually reviewed Dauphin records are preserved, and administrators may create new manual records from official information. Written permission and a separate reviewed engineering change are required before any automated Town provider can be enabled.

The operational controls `domains.beachEvents`, `providers.gulfShoresEvents`, `providers.orangeBeachEvents`, `providers.gulfStateParkEvents`, and `providers.orangeBeachCoastalEvents` support enabled, disabled, and monitor-only states. Disabling this domain returns an empty disabled response without affecting other app data.

### Provider recovery

After a provider failure, an operator should first read the failed provider card and Provider Health incident, confirm the relevant operational control is enabled, and verify the official feed itself is available. A protected manual refresh may then be run once. Do not repeatedly refresh, change match aliases, or enable a disabled provider to hide an upstream failure. A successful refresh clears current failure coverage naturally; last-good published data remains bounded by the 12-hour public stale policy. If the source format changed, update a fixture and parser test before changing production parsing. Dauphin Island remains manual even during a coverage gap.

## Source identity, duplicates, and revisions

Imported identity is `providerId + externalId`. A recurrence with a `RECURRENCE-ID` includes that occurrence timestamp in the external identity. If a feed repeats the same UID for multiple non-identical records without occurrence identifiers, the start timestamp disambiguates those records. Stable source identity updates the existing record when title, time, venue, or other facts change; it does not create a replacement event. iCalendar normalization honors declared `TZID` values, Central floating times, exclusive all-day end dates, daylight-saving boundaries, multi-day spans, cancellation/tentative status, narrow postponement title markers, sequence metadata, and registration-link classification. RRULE text marks an occurrence as recurring but is not expanded into invented future occurrences.

Cross-provider and manual-overlap detection uses exact public identity evidence: same supported beach plus exact normalized title/minute, the same official event URL with overlapping times, or the same normalized title with overlapping times. The system never silently merges these records. Cross-provider candidates remain in the exclusion index with `possibleDuplicateOf`; overlapping manual records are created as pending review with a possible-duplicate flag. Distinct recurrence occurrences remain separate even when they share one official series page, and stable multi-day records remain separate by source identity. UID instability cannot be safely inferred and requires operator review rather than fuzzy merging.

Each normalized source record has a deterministic source revision. Raw-only differences are compared after entity, punctuation, whitespace, HTML, address, and URL normalization. Material fields are title meaning, venue or meaningfully changed normalized address and resulting beach assignment, start/end, all-day/recurring semantics, official and registration destinations, visitor-planning description/contact information, end-time availability, and cancellation/postponement status. Description and title comparison uses exact canonical token sets with explicit word equivalences; it does not use AI, fuzzy similarity, or probabilistic scoring. Tracking parameters, cosmetic URL form, equivalent street abbreviations, punctuation/case-only differences, equivalent entities, harmless markup cleanup, provider sequence/last-modified metadata, and wording changes that leave the canonical meaning tokens unchanged do not force re-review.

For an approved, scheduled, published, hidden, or cancelled event, a material source change preserves the prior facts and review status in `sourceChange` and audit history. A published material change moves to pending review and is removed from public output. A confirmed cancellation moves immediately to cancelled and is removed from public output. A postponement moves a reviewed event to pending review. A harmless normalized change updates the source facts without unpublishing the event.

Absence is evaluated only after a successful, non-monitor refresh of that event's provider. Provider HTTP failures, timeouts, malformed or incomplete feeds, disabled controls/providers, monitor-only runs, and other unsuccessful provider attempts never increment absence tracking. The first successful missing refresh adds `sourceMissing` and preserves the current workflow/public state to tolerate a transient feed omission. A second consecutive successful miss confirms `sourceRemoved`, preserves the prior source version, and moves a reviewed/published event to pending review. Later misses do not rewrite the removal timestamp or generate repeated audit churn. If the stable source identity returns, removal metadata is cleared; restoration after confirmed removal raises `sourceRestored` and remains pending review, while recovery from one transient miss simply clears the warning. Manual, disregarded, expired, and ended records are not removed by provider reconciliation.

## Workflow semantics

- `draft`: locally saved work; not public.
- `discovered`: legacy/reserved non-public state; current automated imports enter pending review directly.
- `pendingReview`: requires an operator decision; not public.
- `approved`: reviewed and accepted, but not public.
- `scheduled`: accepted but not public; there is no automatic scheduled publication job.
- `published`: the only public state, subject to the event display window and expiration filtering.
- `hidden`: explicitly unpublished; not public.
- `disregarded`: rejected as irrelevant; retained for audit and future source refreshes, but not public.
- `cancelled`: cancelled manually or by a confirmed source status; not public.
- `expired`: ended and non-public. Request-time filtering also prevents an ended published record from being served before its stored state is updated.

Approve and publish are deliberately separate. Every manual event is created as `pendingReview`; creation rejects draft, discovered, approved, scheduled, published, hidden, cancelled, expired, or disregarded starting states. Manual and imported events then use the same approval and explicit publication gate. A draft or pending event cannot transition directly to published. Publishing is allowed only from approved, scheduled, hidden, or already published. `scheduled` never publishes automatically and no event-publication cron exists. Disregard retains the record. Unpublish sets hidden. Cancel sets cancelled. Source removal is an attention flag and source revision, not a separate redundant status. Accepting an approved, scheduled, published, or disregarded review—or explicitly acknowledging attention—records the reviewed source revision and clears the current attention flags.

The admin dashboard exposes queues for new events, changed-after-approval, ambiguous matches, possible duplicates, normalization warnings, provider failures, published events needing attention, removed/cancelled records, manual events, and expired records. Review shows the assigned beach, venue, normalized address, deterministic match method/explanation/rule, automatic or manual origin, source/reviewed revisions, warnings, material before/after facts, and event-scoped audit history.

## Public API allowlist and audit privacy

The public response envelope contains schema/status/revision timestamps, official attribution, and events grouped by canonical beach ID. An event serializer explicitly permits only: `id`, `beachId`, `title`, `venue`, `address`, `startAt`, `endAt`, `displayFrom`, `allDay`, `recurring`, `eventType`, `impactLevel`, banner and visit-impact fields, `sourceName`, sanitized summary/description fields, official/registration/events-page/organizer links, public source note/contact/newsletter month, `endTimeUnavailable`, and `updatedAt`. The public `id` is the intended stable app event identifier.

Raw facts, source-calendar/feed URLs, provider configuration, operational-control reasons, match method/confidence/rules, debug data, internal notes, review warnings/flags, possible-duplicate references, audit history, source revisions, and removal metadata are never serialized. Attribution URLs are selected from sanitized public official destinations rather than feed URLs. Allowlist tests compare the complete serialized key set and exercise disabled-endpoint privacy.

Important event actions write timestamp, action, previous/new state, changed field names, source revision, manual or automated origin, operator identity when available, public-output effect, and an optional reason. Material automated source changes also retain previous and next source facts. Audit data is admin-only and does not enter snapshots or notification recipient configuration.

## Review notifications

Beach Activity Review Notifications use the existing production Worker email binding and the allowlisted recipients in `BEACH_ACTIVITY_NOTIFICATION_RECIPIENTS`. `BEACH_ACTIVITY_NOTIFICATIONS_ENABLED` supplies the default master state; protected admin preferences can enable the daily reminder and select a 15-minute Central-Time reminder boundary. The production default is 7:15 a.m. Central.

Automatic review-summary delivery is evaluated only by the 15-minute scheduler when the configured morning time matches in `America/Chicago`. Provider refreshes and administrator creates, edits, deletes, assignments, or queue changes never send an automatic review summary. The actionable morning queue includes new records, material source changes, possible duplicates, provider failures, cancellations/removals, ambiguous matches, normalization warnings, and unreviewed events starting within 72 hours. At most one automatic summary is sent per Central calendar morning, even if the queue changes later that morning; empty queues never send. An unchanged actionable set remains deduplicated within that morning and may produce the next morning's reminder if it still needs action. Explicit manual review-summary and test-send endpoints remain operator actions. Test sends do not change event records or notification reminder/deduplication state.

The summary contains limited factual metadata, high-impact-first ordering, official source links, and links to Review Events, Provider Health, and Operational Control. Delivery is attempted twice before a terminal failure. Configuration changes, sends, retry attempts, suppressions, disabled or monitor-only decisions, and failures are retained in the administrative audit history. Current queue revision, counts, last success/failure, provider error, and duplicate count are persisted for admin observability. Provider Health reports the internal `beach_activity_notifications` provider, while the `notifications.beachActivity` operational control can enable, disable, or monitor the subsystem without affecting beach-event ingestion or publication.

## Administration and decision memory

Administrators review source, venue, address, assigned beach, deterministic confidence/explanation, rule, type, impact, banner wording, recurrence, source link, notes, changes, and similar decisions. Imported occurrences can be approved, edited, disregarded, cancelled, hidden, or published. Excluded and unsupported source facts are retained for 90 days in a separate administrative candidate index. Assigning a candidate or creating an exact venue/address alias never publishes it; the occurrence still enters pending review. Auto-approval requires an exact provider, exact venue, exact beach, and exact match confidence, and produces `approved`, not `published`. Ignore rules may also include a title pattern. Every mutation writes an audit record.

Manual records require a canonical beach, valid time range, known type and impact, HTTPS source URL, banner wording, and organizer/source. They preserve a manual source revision and administrator assignment explanation. Creation always begins in pending review; approval and publication are separate later operator actions. An overlap with an automated record is flagged for review. A West End Beach event uses `dauphin-island-public-beach` while retaining West End Beach as its venue. Trusted-organizer accounts and organizer access are future work.

## Legal and editorial notes

Store normalized facts and app-authored summaries. Do not claim a beach is packed, quiet, not crowded, or has parking available. Event details can change; users should confirm with the organizer. Source names and official HTTPS links remain visible.

## Refresh coordination decision (2026-08-17)

The refresh-status read/write check in Workers KV is advisory, not a globally exclusive lock. KV is eventually consistent and concurrent Workers can both observe an available lock. Beach-event refreshes currently start only from the scheduled Worker handler and the Access-authenticated internal refresh route. Production should operationally nominate the scheduled handler as the single routine coordinator and restrict manual refreshes to exceptional operator use.

Each run now records a `runId` and checks ownership before snapshot publication and again before final status publication. A run already known to be superseded stops stale publication. This narrows stale-write risk but does not make acquisition exclusive and cannot eliminate a race after the final ownership read.

| Option | Failure recovery | Deployment and compatibility | Cost/complexity | Required before production? |
| --- | --- | --- | --- | --- |
| Operational single coordinator | Existing stale timeout and operator retry; overlapping manual runs remain possible | No new binding; fully compatible | Lowest | Recommended for the current staging checkpoint, with manual refresh access restricted |
| Durable Object coordinator | Strong per-object serialization; alarms/retry can recover abandoned work | Requires a new binding, class migration, routing, and deployment review | Medium | Not required if operational single-coordinator discipline is acceptable; preferred if concurrent triggers become routine |
| D1 transactional lease/job | Transactional lease ownership and queryable job history; explicit expiry/recovery | Requires D1 schema, binding, migration, and operational ownership | Highest | Not required for the current workload; consider only if durable job history or broader orchestration is needed |

No Durable Object or D1 binding is introduced by this decision.
