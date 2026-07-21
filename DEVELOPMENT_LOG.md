# Development Log

## July 21, 2026 — Verification production audit and alert hardening

- Confirmed all scheduled 7:00 AM/noon Central reports exist from July 18 through July 21; no scheduled slot was missed.
- Identified a July 21 noon `official_source_format_changed` warning after CivicPlus replaced the active Gulf Shores closure image IDs with `4339/4340`.
- Updated the independent verifier for those observed closure IDs and normalized the temporary public `double-red` compatibility value back to canonical `doubleRed` for comparison.
- Restricted email incidents to actionable failures; warnings remain visible in reports without opening or resolving an incident.
- Added provider, location, expected value, actual value, timestamp, and failure reason diagnostics, including recovery context.
- Added explicit missing-binding coverage while preserving delivery-failure isolation. Production and staging delivery remain disabled; no deployment or email was performed.

## July 19, 2026 — NWS rip current outlook

- Added narrow official NWS Mobile/Pensacola discovery and image verification.
- Added public metadata/image routes, scheduled and protected refresh, last-known-good fallback, conditional requests, hashing, and separate non-alerting verification.
- Added backend coverage for discovery, replacement/unchanged behavior, validation failures, fallback, cache headers, and revision consistency.

## July 18, 2026 — Factual Verification Phase 2 alerting core

- Added durable new/continuing/changed/recovered incident transitions to the existing verification coordinator.
- Added silent passing behavior, duplicate notification keys, escalation/change updates, and one-time recovery.
- Added 30-minute-grace missing-report checks on the existing 15-minute trigger for the 7:00 AM/noon Central schedule, including DST behavior.
- Added a delivery-only `VERIFICATION_ALERTS_ENABLED` kill switch; verification and 30-day report retention are unchanged.
- Isolated alert state and delivery errors from report creation, public routes, refresh, parsing, and publishing.
- Added deterministic Phase 2 tests. Cloudflare Email Service is recommended, but no binding, address, external resource, production configuration, deployment, or delivery activation was added pending approval.

Operational boundary: notification intent is persisted before delivery to prevent duplicate sends. A failed or ambiguous send is logged without content and is not automatically retried. Immediate disable is `VERIFICATION_ALERTS_ENABLED=false` followed by a configuration-only deployment.

Added the approved Cloudflare Email Service adapter in a separate change. The binding is restricted to `alerts@alabamabeachflag.com` as sender and `operations@alabamabeachflag.com` as its fixed destination. Production and staging remain explicitly disabled pending controlled staging validation. No real email, external resource creation, deployment, or third-party credential was involved.

## July 17, 2026 — Factual Verification Phase 1

Completed the independent Gulf Shores factual verification system.

- Added independent official-source parsing and comparisons for Gulf Shores Public Beach, Gulf State Park Pavilion, and Little Lagoon Pass.
- Added flag-color, purple-advisory, freshness, missing-location, provider-error, and API-availability checks.
- Added structured pass, warning, and fail reports.
- Added `verification:latest` plus 30-day dated Workers KV reports.
- Added the `VerificationCoordinator` Durable Object and migration `v2-verification-coordinator` for duplicate-slot protection.
- Added Cloudflare Access-protected run and latest-report routes.
- Added hourly UTC scheduling gated to 7:00 AM and noon `America/Chicago`.
- Confirmed production Access service-token authentication with the legacy fallback disabled.
- Deployed the initial Phase 1 release as version `0a6a42a4-8ecd-4dfe-a9ac-954571560200`.
- Deployed the required live-page nested-container parser correction as version `7608f65f-7200-4058-95bb-06ad5369dd5c`.
- Completed an authenticated production run for slot `2026-07-17T13`: overall pass, fresh data, no Gulf Shores provider errors, and matching yellow flag plus active purple advisory at all three locations.
- Confirmed a repeated request for the same slot returned HTTP `409` and produced no additional dated KV report.

Phase 1 observes and reports only. It does not modify production flag publishing, refresh coordination, or provider parser output.

Future work is limited to alert delivery, recovery notifications, and carefully scoped additional official sources.
