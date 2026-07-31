# Development Log

## July 30, 2026 — Main-card water-temperature fallback policy

- Aligned the four regional cards with explicit ordinary observation chains: Gulf Shores and Orange Beach use `PPTA1 → 42012 → 42357`; Fort Morgan uses `DPHA1 → 42357 → 42012`; Dauphin Island uses `8735180 → 42357 → DPHA1`.
- Preserved ordered first-current selection, station-specific stale and unavailable thresholds, direct-observation provenance, and unavailable behavior when all approved sources fail.
- Updated Provider Health, API/iOS tests, user-facing source context, operational documentation, and the Obsidian decision record.
- Historical note: this entry predates the July 30, 2026 seasonal-awareness policy. Vibrio banner eligibility is now intentionally independent of source arrays, observation freshness, and environmental calculations; those configurations remain for ordinary temperature and possible future-model use.

## July 30, 2026 — Seasonal Vibrio awareness approval

- Recorded the product-owner decision to release the feature as seasonal CDC safety awareness, not a bacterial or infection-risk model.
- Enabled the production deployment flag while preserving direct observations, source-specific freshness, deterministic fallback, exact CDC wording, and fail-closed output.
- Added the isolated `domains.vibrioAwareness` runtime kill switch to the existing authenticated, revision-checked, audited Operational Control system.
- Kept Gulf State Park Pavilion and Little Lagoon Pass excluded. External scientific review remains required for a predictive rainfall/salinity model or coverage expansion.

## July 22, 2026 — Phase 2 production rollout

- Deployed independent Gulf Shores and Orange Beach factual verification, multi-verifier history/admin reporting, cron heartbeats, and freshness diagnostics.
- Validated staging failure, suppression, pass, and recovery behavior with delivery disabled.
- Completed a controlled staging email test: one incident email, no duplicate incident email, and one recovery email.
- Activated production verification email delivery after staging validation. Staging delivery remains disabled by default.

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
