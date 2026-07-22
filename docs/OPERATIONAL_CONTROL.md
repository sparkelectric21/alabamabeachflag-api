# Phase 1 operational control

Phase 1 protects beach-flag publication without creating a general feature-flag platform.

## Controls and precedence

The only enforced controls are `global.liveData`, `domains.beachFlags`, `providers.gulfShoresFlags`, and `providers.orangeBeachFlags`. Evaluation order is global, domain, provider, automatic validation/freshness, then the normal payload. The most restrictive applicable state wins. Fort Morgan inherits Gulf Shores. Dauphin Island remains unavailable because it has no official feed.

States are `enabled`, `disabled`, and `monitorOnly`. An expired control defaults to `require_review`, which remains disabled until an operator restores it. `onExpiry: enable` is the only automatic-enable policy.

## Storage and audit

- `operational-control:v1:current`
- `operational-control:v1:snapshot:<revision>`
- `operational-control:v1:audit:<timestamp>:<uuid>`

Mutations require the current revision in `If-Match`. Every transition and rollback writes snapshots and a separate audit entry. Rollback creates a new revision. Authentication values, Access JWT contents, and secrets are never stored.

Protected routes use the existing Cloudflare Access/Worker authorization path:

- `GET|PATCH /admin/operational-control`
- `POST /admin/operational-control/rollback`
- `GET /admin/operational-control/audit`

The website uses the same-origin `/admin/service` proxy.

## Public contracts

`GET /v1/app-configuration` returns only capability-oriented availability, the public control revision, a 30-second cache deadline, and version policy. It never includes actor identity, incident notes, or operator free text.

`GET /v2/beach-flags` adds per-beach availability. Stable unavailable reasons are `temporarily_disabled`, `stale`, `provider_unavailable`, and `validation_failed`. No unavailable entry contains a flag value.

`GET /v1/beach-flags` retains its required schema and the existing iOS 1.2 Double Red compatibility rewrite. Known-disabled, stale, or invalid reports are removed rather than serialized as an unknown value. Old clients may retain a flag already cached locally; the backend cannot erase those caches.

## Publication and freshness

The hard flag-age ceiling is 60 minutes. A report becomes unavailable only after it exceeds the boundary. Serve-time serialization reads current control intent. The Durable Object reads it again inside the final commit boundary, preventing a refresh that began before activation from publishing affected reports. Providers continue to be queried while disabled so verification and recovery evidence can accumulate.

Total empty or invalid candidates cannot create a publishable flag. Independent provider output is preserved during partial failure. Public safety and configuration responses use `Cache-Control: no-store`. Workers KV is eventually consistent, so the operator must verify the public revision after a change.

## Incident procedure

1. Confirm the affected provider/domain and collect verification evidence.
2. Select `monitorOnly` for observation or `disabled` for enforcement.
3. Supply a reason code, operator reason, duration, expiry behavior, and incident ID when available.
4. Confirm broad global/domain disables explicitly.
5. Poll `/v1/app-configuration` until the expected public revision appears, then inspect `/v2/beach-flags` for every affected beach.
6. Verify unaffected provider output remains available.
7. Before restore, obtain a fresh successful official-source observation after activation. Restore with `manual_restore`; a capable client still requires a fresh v2 flag fetch.
8. Use rollback only to reproduce a complete earlier configuration. Rollback never deletes audit history.

For emergency inspection, read the current key, matching snapshot, latest audit entries, public configuration revision, and v2 availability. Do not edit provider catalog roles; they remain non-operational metadata.
