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
