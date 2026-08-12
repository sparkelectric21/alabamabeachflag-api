# Information reports

Version 1.2.1 stores private, user-submitted correction reports in two tables
that are logically isolated from historical observations:
`information_reports` and `information_report_history`.

The Worker currently accesses these tables through the existing
`HISTORICAL_DATA` D1 binding. Despite its narrow legacy name, this is the
project's existing private operational D1 binding. A future infrastructure
cleanup may rename or separate the binding after deployment planning; that
naming cleanup is intentionally not required for the 1.2.1 feature and does
not change the report schema or repository boundary.

Migration `0003_information_reports.sql` is forward-only and must be reviewed
and applied through the normal release process. Local development should apply
it only to disposable local D1 state. Reports are never interpreted as source
data and no report action changes published beach, condition, map, source, or
Learn content.

## Public route and abuse protection

Public submissions use the custom-domain report route: production iOS sends
`POST https://www.alabamabeachflag.com/v1/information-reports`, and staging QA
sends `POST https://staging.alabamabeachflag.com/v1/information-reports`.
The Worker rejects direct `workers.dev` submissions for this endpoint before
body parsing, D1 persistence, audit creation, or notification handling.
Its Cloudflare Worker route ends in `*` solely because Cloudflare route
matching includes the query string; application routing still accepts only the
exact `/v1/information-reports` pathname. The wildcard does not authorize
adjacent or descendant paths.

Deploy a Cloudflare Free zone-level WAF rate-limiting rule with the exact
expression `(http.request.uri.path eq "/v1/information-reports")`. Count by
source IP at Cloudflare's edge, allow five requests per 10 seconds, and block
for 10 seconds with an HTTP block response (not an interactive challenge). The
Free plan cannot filter by HTTP method or hostname, so this exact-path rule
applies across the zone; the application accepts only POST. Staging and
production custom-domain routes share that zone rule.
`http.request.uri.path` excludes query strings, so the WAF protects this
endpoint with or without query parameters.

Cloudflare transiently processes the source IP for this edge protection. The
application does not store source IP in report records, D1, KV, application
logs, email, audit history, models, or admin responses. The iOS outbox treats
every HTTP `429` as retryable without requiring JSON: valid delta-seconds
`Retry-After` pauses the queue durably across relaunches, while a missing or
malformed value uses bounded exponential backoff. The client report ID remains
until accepted or idempotent-duplicate success.
