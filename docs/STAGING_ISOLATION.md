# Staging isolation contract

Staging is untrusted with respect to external side effects. Its deployable configuration explicitly has `crons: []`, no email binding, and false provider-fetch, external-email, and synthetic-fixture flags. Missing or conflicting environment labels fail closed. Production scheduling and configuration are unchanged.

## Threat model and policy

- A dashboard-created cron, direct scheduled invocation, authenticated manual refresh, internal refresh, coordinator retry, or verification run must not reach a provider unless the runtime is consistently labeled `staging` and `STAGING_LIVE_PROVIDER_FETCH_ENABLED=true`. Enabling that flag or adding a schedule requires separate authorization.
- The scheduled Worker remains the sole routine production refresh coordinator. Manual refresh is exceptional operator use. KV ownership checks are advisory; Durable Object coordination is used for applicable refresh jobs.
- Staging never delivers external email. The runtime suppresses delivery even if an email binding or general enable flag is accidentally present. Suppression is recorded as `delivery_suppressed` where notification state exists.
- Diagnostics at authenticated `GET /admin/environment-diagnostics` contain labels and booleans only—never Cloudflare IDs, addresses, tokens, secrets, or raw configuration.

## Synthetic fixture safety

`src/local/eventStagingFixture.ts` is a local/miniflare-compatible runner, not an HTTP route. It accepts no URL or payload. Its committed calendar is parsed by the real iCalendar parser and passed through import, lifecycle, provider-health, snapshot, observation, and audit-capable storage paths. A scoped KV adapter prefixes every key with `synthetic:events-isolation-v1:`. Cleanup lists and deletes only that exact prefix. The runner requires consistent staging labels plus `STAGING_SYNTHETIC_FIXTURES_ENABLED=true`; the deployable default is false. It records fixture-set version and deterministic run context. Additional complete/304/validator scenarios remain covered by the ingestion regression suite rather than simulated network calls here.

## Durable Object inventory and proof

No Durable Object infrastructure is changed by this work. Bindings and legacy migration tags are:

- `REFRESH_COORDINATOR` → `RefreshCoordinator`; migration `v1-refresh-coordinator`. Called only by `services/refresh/dispatch.ts`, keyed by refresh job.
- `VERIFICATION_COORDINATOR` → `VerificationCoordinator`; migration `v2-verification-coordinator`. Called by verification run/monitor routes and read by verification admin diagnostics, keyed as `fleet`.

The synthetic event runner invokes neither binding. Cloudflare associates a Durable Object namespace with the deployed script/class; an environment binding without an explicit production `script_name` normally resolves to that environment's script namespace. Do not claim separation from configuration alone. After an authorized deployment, collect read-only evidence showing the deployed staging script name, both binding class targets and namespace IDs, and the corresponding production values; verify the IDs differ and no staging binding names the production script. Retain command output without secrets.

## Deployment prerequisites and rollback

Before a separately authorized isolated deployment: validate the staging hostname and Access audiences, confirm KV/D1 IDs differ from production without publishing them, prove Durable Object namespace separation, confirm no email binding and no dashboard cron, and leave all three staging flags false. Roll back by selecting the prior Worker version and rechecking bindings/triggers; never use a production binding as a fallback. Provider refresh, fixture execution, migrations, schedule creation, email configuration, Access changes, deployment, and external verification all require separate authorization.
