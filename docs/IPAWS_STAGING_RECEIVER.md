# IPAWS HTTPS Pub/Sub Receiver (Staging)

Alabama Beach Flag is using the FEMA redistribution model, not an Alert Origination Software Provider role.
No FEMA Users Portal user credentials (username, password, API key, MOA) are required for this distribution path.

This document covers the staging-first IPAWS receiver implementation currently deployed only in non-production environments.

## What is implemented

- New endpoint: `POST /v1/ipaws/pubsub`.
- Accepts AWS SNS HTTPS delivery envelopes for:
	- `Notification`
	- `SubscriptionConfirmation`
	- `UnsubscribeConfirmation` (treated as subscription-style message)
- Verifies SNS signature using certificate URL and signed payload rules.
- Strictly validates SNS certificate URLs and SubscribeURL URLs:
	- HTTPS only
	- no credentials/hash/port/fragment
	- hostname under `amazonaws.com`
	- SubscribeURL must be an SNS endpoint path `/`
- Persists ingestion records in KV (`BEACH_DATA`) before user-facing work.
- Supports duplicate-message handling for the same SNS `MessageId` (idempotent acknowledgement).
- CAP parsing is separated in `src/ipaws/parser.ts` and supports raw XML or JSON CAP-like payloads.
- Parser extracts lifecycle-related fields used for future planning:
	- `identifier`, `references`, `sender`, `status`, `msgType`, `event`, `urgency`, `severity`, `certainty`, `effective`, `onset`, `expires`, `headline`, `description`, `instruction`, and area geometry/geocode fields.
- Health snapshot is merged into provider-health admin output at `ipawsReceiver`.

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

## Persistence and idempotency

The persistence key uses `ipaws:ingest:<MessageId>` and stores:

- generated internal record ID
- SNS `MessageId`, `Type`, `TopicArn`, and `Timestamp`
- receipt timestamp
- signature result
- raw message
- parse status + parse errors/reasons
- parsed CAP summary fields
- lifecycle outcome and duplicate tracking

## Current limitations

- No IPAWS user-facing alert publication is added in this phase.
- No notification push integration is added in this phase.
- No FEMA endpoint is contacted from this code.
- CAP parsing is intentionally tolerant and non-authoritative:
	- only supported/recognized fields are persisted
	- malformed payloads are stored as parse failures
- Geographic filtering and relevance routing are intentionally deferred.

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

After validation, each `MessageId` is claimed by a dedicated Durable Object. This serializes concurrent deliveries globally and prevents the KV read-before-write race that existed in the deployed baseline. Failed application handoffs release the short processing lease for retry; completed deliveries remain claimed.

Valid CAP notifications are normalized into `ipaws:normalized:<MessageId>` records. The normalized schema is explicitly staging-only (`environment: staging`, `handoffState: staged`, `notificationsEnabled: false`). This Worker has no production user, email, queue, service, or notification binding, so the handoff is storage-only and cannot send notifications.
