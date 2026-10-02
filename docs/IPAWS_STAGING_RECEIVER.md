# IPAWS HTTPS Pub/Sub Receiver (Staging)

Alabama Beach Flag is using the FEMA redistribution model, not an Alert Origination Software Provider role.
No FEMA Users Portal user credentials (username, password, API key, MOA) are required for this distribution path.

This document covers the staging-first IPAWS receiver implementation currently deployed only in non-production environments.

## What is implemented

- New endpoint: `POST /v1/ipaws/pubsub`.
- Accepts AWS SNS HTTPS delivery envelopes for:
	- `Notification`
	- `SubscriptionConfirmation`
	- `UnsubscribeConfirmation` (recorded only; its URL is never fetched)
- Verifies SNS signature using certificate URL and signed payload rules.
- Strictly validates SNS certificate URLs and SubscribeURL URLs:
	- HTTPS only
	- no credentials/hash/port/fragment
	- hostname under `amazonaws.com`
	- SubscribeURL must be an SNS endpoint path `/`
- Persists ingestion records in KV (`BEACH_DATA`) before user-facing work.
- Uses strongly serialized `acquired`, `processing`, and `complete` states with an unpredictable owner token on every acquisition. In-progress duplicates receive 503; a 200 duplicate acknowledgement requires verified persisted output.
- Recovers released/expired partial work and reconstructs missing normalized output behind a completed marker.
- CAP parsing is bounded and namespace-aware for CAP 1.2 XML. DTDs, custom entities, processing instructions, malformed structure, incorrect namespaces, excessive complexity, and missing/invalid required fields fail closed and cannot create normalized output.
- Parser extracts lifecycle-related fields used for future planning:
	- `identifier`, `references`, `sender`, `status`, `msgType`, `event`, `urgency`, `severity`, `certainty`, `effective`, `onset`, `expires`, `headline`, `description`, `instruction`, and area geometry/geocode fields.
- Health snapshot is merged into provider-health admin output at `ipawsReceiver`.
- Privacy-preserving operational metrics are stored in strongly consistent UTC-hour aggregates and exposed as a sanitized staging-only soak report.

## Durable operational metrics and soak reports

Every callback attempt that reaches the handler makes one best-effort metrics write to the existing `IPAWS_IDEMPOTENCY` Durable Object namespace. A reserved deterministic object name keeps aggregate state separate from per-`MessageId` claim objects. No new binding, migration, Cloudflare route configuration, queue, recipient, secret, or Cloudflare resource is required. The object transactionally updates one UTC-hour bucket, so concurrent requests do not use unsafe KV read-modify-write counters.

The metrics schema contains only fixed, low-cardinality dimensions:

- request count; HTTP `2xx`/`4xx`/`5xx`; and bounded handler outcome;
- SNS type (`Notification`, `SubscriptionConfirmation`, `UnsubscribeConfirmation`, or `unknown`);
- signature result plus TopicArn and timestamp validation-failure counts;
- CAP parse result and lifecycle (`Alert`, `Update`, `Cancel`, `Test`, `other`, or `not_applicable`);
- idempotency acquisition, processing/completed duplicates, lease recovery, completion, and failure;
- normalized-record success, reconstruction, failure, or not-applicable;
- fixed processing stages and sanitized failure classes, plus the latest failure timestamp/stage/class;
- privacy-preserving resolution of an initial-claim failure by a later accepted delivery;
- retryable/permanent rejection, unexpected exceptions, bounded latency totals/max/histogram, and the latest successful-delivery timestamp.

Metric events, buckets, and reports never accept or persist raw SNS/CAP bodies, arbitrary error text, personal information, message or CAP identifiers, ownership tokens, signatures, certificates, URLs, TopicArns, or secrets. An event with extra fields is reduced to the allowlisted counters before storage. Latency is clamped to five minutes and reported in fixed buckets.

The MessageId prohibition is scoped to observability and unauthenticated input: MessageId never appears in metrics, retry-correlation markers, public reports, logs, warnings, or callback response bodies. Successfully authenticated SNS deliveries continue to retain MessageId in the existing access-controlled staging ingestion and normalized records for traceability and idempotent processing; this change does not expand that retention or access. Invalid-signature records use a random internal storage key and retain no MessageId or raw body.

Storage is bounded to at most **840 hourly buckets**: the current UTC hour plus the preceding 839 hours (35 days). Empty hours do not create buckets. Reports exclude buckets outside retention immediately, and the next metrics update physically evicts them. A bucket contains only fixed counters and latency aggregates; at the current schema its serialized upper bound is under 8 KiB, so 840 full buckets are conservatively under 6.6 MiB. Correlation state is separately capped at 256 markers and three rotating 32-byte HMAC keys.

Schema version 2 uses new hourly storage keys and does not reinterpret the previous daily aggregates. A staging deployment therefore begins a new windowed series while leaving legacy keys untouched; normal bounded v2 writes and retention do not enumerate or expose those legacy values.

Retry correlation is best-effort. The singleton object receives the `MessageId` only through an internal Durable Object call, derives an HMAC marker with a random key held only in Durable Object storage, and never stores or returns the identifier. Keys rotate hourly; markers expire after two hours and are capped at 256. A later accepted delivery is checked against the retained key ring and increments only the fixed `resolved_after_preclaim_failure` counter. Metrics/correlation failure cannot change the SNS response, so this counter may undercount.

Retrieve a sanitized report without Cloudflare management APIs:

```sh
curl --fail-with-body --silent --show-error \
  'https://<staging-ipaws-host>/v1/ipaws/metrics?start=2026-09-29T14%3A00%3A00.000Z&end=2026-09-29T21%3A00%3A00.000Z' | jq .
```

`GET /v1/ipaws/metrics` is read-only, returns `Cache-Control: no-store`, and contains aggregate operational data only. Staging uses the existing canonical window-specific 30-second edge cache. Production requires a configured `IPAWS_METRICS_READ_TOKEN` secret and a matching Bearer credential, returns no report when authentication is absent or invalid, and bypasses the shared cache. Optional `start` and `end` must be canonical UTC-hour timestamps, must be supplied together, use an inclusive-start/exclusive-end interval, and may span at most seven days. The start cannot precede the retained 840-hour horizon and the end cannot exceed the next UTC-hour boundary. Omitting both selects the last 72 complete-or-current UTC hours. Unknown, repeated, partial, noncanonical, inverted, out-of-retention, future, or oversized selectors return `400`. There is no pagination or key enumeration. The endpoint returns `503 ipaws_metrics_unavailable` if the Durable Object report cannot be read.

Metrics are deliberately fail-open relative to observability: the Worker schedules the write with `waitUntil`, and a metrics write or report failure never delays or changes a valid FEMA delivery response. A failed write emits one fixed, sanitized Worker warning and does not attempt another metrics write, preventing recursive failure reporting. Consequently, the report is evidence for successfully recorded observations, not an independent request ledger. Compare `counters.request.received` with Cloudflare Worker request analytics for the same UTC window. A receiver `4xx`/`5xx`, bounded handler failure, or unexpected-exception counter indicates a receiver outcome. A failed Wrangler/API/dashboard query with a healthy direct report is a Cloudflare management/API observation failure. A direct-report `503` or a gap between Worker analytics and recorded requests indicates a metrics path or platform/storage observation failure and must not be labeled a FEMA or receiver-processing failure without corroborating request outcomes.

For a soak, choose hour-aligned UTC boundaries and request that exact inclusive-start/exclusive-end window after allowing for analytics lag. Buckets are intentionally not reset: reset operations would be destructive and are not exposed.

## Safe configuration

All staging controls are environment-driven and set in Wrangler files:

- `IPAWS_INGESTION_ENABLED` (default: `false`)
- `IPAWS_ENVIRONMENT` (`staging` by default for staging config)
- `IPAWS_ALLOWED_TOPIC_ARNS` (optional, comma-separated whitelist)
- `IPAWS_AUTO_CONFIRM_SUBSCRIPTION` (default: `false`)
- `IPAWS_PARSE_BYTE_LIMIT`
- `IPAWS_RECORD_TTL_SECONDS`
- `IPAWS_SUBSCRIPTION_TTL_SECONDS`
- `IPAWS_HEALTH_TTL_SECONDS`

## Staging behavior

- Signature failures return 400 and do not treat the message as a successful delivery.
- Unknown/unsupported SNS types are rejected.
- `SubscriptionConfirmation` is **not** auto-confirmed unless `IPAWS_AUTO_CONFIRM_SUBSCRIPTION=true`.
- Confirmation requests are never fetched from untrusted URLs due strict URL checks.
- `SubscribeURL` must contain exactly one case-sensitive `Action=ConfirmSubscription`, `TopicArn`, and `Token`; the latter two must match the signed envelope.
- Transient certificate/confirmation network errors, 429s, and upstream 5xx responses return 503; permanent validation failures return 4xx.

## Persistence and idempotency

For successfully authenticated SNS messages, the persistence key uses `ipaws:ingest:<MessageId>` and stores:

- generated internal record ID
- SNS `MessageId`, `Type`, `TopicArn`, and `Timestamp`
- receipt timestamp
- signature result
- raw message
- parse status + parse errors/reasons
- parsed CAP summary fields
- lifecycle outcome and duplicate tracking

The Durable Object claim and KV outputs are not one transaction. Every post-claim failure attempts a token-fenced release, expired leases are recoverable, and completion occurs only after expected ingestion, subscription, and normalized outputs can be read back. A stale owner receives a conflict and cannot renew, release, or complete a newer owner's lease. The receiver renews ownership after the initial durable write and again before completing a notification. This provides bounded at-least-once recovery for the verified staging outputs, not globally atomic exactly-once effects; future consumers need their own transactional idempotency.

## Current limitations

- No IPAWS user-facing alert publication is added in this phase.
- No notification push integration is added in this phase.
- No FEMA endpoint is contacted from this code.
- Signed malformed CAP payloads are retained as bounded raw `parse_failed` records and never become normalized alerts. Invalid-signature records use random internal keys and retain only bounded envelope metadata and a SHA-256 digest of the untrusted message body; MessageId and the raw body are not stored or parsed.
- Successfully authenticated JSON arrays, JSON scalar values, and non-JSON/non-XML text are retained for the same bounded period as `notification_unsupported` records. They are terminal accepted outcomes, are never normalized, and cannot trigger downstream effects. Metrics expose only the fixed classes `json_array`, `json_scalar`, or `opaque_text`; payload content and identifiers are excluded. Malformed CAP XML remains `parse_failed`, while unexpected parser/runtime exceptions remain processing failures. This prevents unsupported upstream structures from being mislabeled as parser defects.
- Geographic filtering and relevance routing are intentionally deferred.
- Best-effort metrics can undercount if the metrics Durable Object call fails after the receiver has determined its response. Cloudflare request analytics are the independent denominator; neither source proves what FEMA attempted before Cloudflare accepted a request.

## Before FEMA production onboarding

Before sharing an endpoint with FEMA Production, confirm at minimum:

1. Exact AWS SNS TopicArn(s) are known for the intended channel.
2. Expected subscription confirmation behavior is approved.
3. Payload schema is validated against real FEMA staging deliveries.
4. CAP lifecycle correlation and update/cancel logic are implemented in a controlled follow-up phase.
5. Staging and production routing, secret handling, and alerting workflows are approved.
# Security and application handoff

The receiver accepts an SNS envelope only after all of the following checks succeed:

- the exact `TopicArn` is present in the staging allowlist;
- the signed timestamp is no more than 3,600 seconds old and no more than 300 seconds in the future;
- the certificate URL is HTTPS on an exact `sns.<region>.amazonaws.com` host, uses the AWS SNS certificate path shape, contains no credentials, non-default port, fragment, or query, and does not redirect;
- Cloudflare's outbound TLS stack authenticates that AWS hostname before returning the certificate;
- the returned X.509 object is a currently valid, non-CA RSA leaf whose subject identifies SNS or whose issuer identifies the Amazon/Starfield AWS trust family;
- the SNS PKCS#1 v1.5 signature verifies using SHA-1 for SignatureVersion 1 or SHA-256 for SignatureVersion 2.

This certificate strategy deliberately combines platform TLS trust and a pinned AWS origin with explicit leaf validity and SNS identity checks. AWS has used both CA-issued and self-issued SNS message-signing certificates, so issuer-name heuristics are not treated as a trust anchor; trust is anchored to the authenticated AWS HTTPS origin that supplies the certificate. The Worker never accepts a certificate supplied from another origin and never follows a redirect. If AWS changes the documented SNS certificate identity, the receiver fails closed and this policy must be reviewed before widening it.

After validation, each `MessageId` is claimed by a dedicated Durable Object. Each acquisition or post-expiry reacquisition creates a unique owner token stored with the processing lease and returned only over the internal Durable Object call. Renew, complete, and release compare that token and mutate state in the same storage transaction; stale or expired owners receive HTTP 409 and the Worker returns 503 instead of falsely acknowledging completion. The token is ephemeral internal security state: it is not written to IPAWS records, logged, or returned to SNS. This serializes concurrent deliveries globally and prevents the KV read-before-write race that existed in the deployed baseline. Failed application handoffs attempt a fenced release, lease expiry permits retry after interruption, and completed deliveries remain claimed.

Valid CAP notifications are normalized into `ipaws:normalized:<MessageId>` records. The normalized schema copies the validated environment provenance from the authenticated ingestion record; this staging Worker therefore produces `environment: staging`. Existing authenticated staging records that predate the field are upgraded only when a newly verified staging delivery matches their stored MessageId, TopicArn, and raw message. Production rejects every environment-less record pending a separately authorized provenance migration. Ambiguous legacy records, cross-environment records, and malformed or mismatched normalized outputs fail closed or are reconstructed from the verified staging record before acknowledgement. `handoffState: staged` and `notificationsEnabled: false` remain fixed. This Worker has no production user, email, queue, service, or notification binding, so the handoff is storage-only and cannot send notifications.
