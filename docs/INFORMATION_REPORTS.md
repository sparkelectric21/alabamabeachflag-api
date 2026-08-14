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

## Client architecture disposition

The production iOS app does not download or parse ADEM workbooks. It requests
the normalized `/v1/water-quality` JSON response from this backend. Workbook
download, parsing, validation, normalization, and caching belong to
`src/services/adem` in the Worker. The unfinished client-side
`ADEMWaterQualityParser` was unused legacy scaffolding and was removed for
version 1.3.0 so the app cannot drift into a conflicting second parser.

Migration `0003_information_reports.sql` is forward-only and must be reviewed
and applied through the normal release process. Local development should apply
it only to disposable local D1 state. Reports are never interpreted as source
data and no report action changes published beach, condition, map, source, or
Learn content.

## Submitted fields, purpose, and retention

Submitting a report is optional. The client requires a category and a
user-entered explanation. A contact email address is optional. The submitted
record also contains its client creation time, a client-generated report ID
used for idempotency, app version and build, platform, screen and content
context identifiers, readable context title, and catalog version when
available. Device location is not requested or submitted.

The private review workflow uses this information to identify, investigate,
deduplicate, and resolve a possible content or app-behavior issue and, when an
email address was supplied, to contact the reporter about that report. A new
report may trigger a private reviewer notification containing a bounded
preview, but reports and review fields are not returned by public endpoints.

Accepted reports and their review history are stored in the private D1 review
tables. The current implementation has no automatic retention period and no
report-deletion route. Changing a report to `resolved`, `dismissed`, or
`duplicate` does not delete its record or history. The website privacy policy
therefore directs a person to the privacy contact for a request concerning an
accepted report without promising automatic deletion. Deleting an unsent
report in the iOS outbox affects only that pending on-device copy.

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
