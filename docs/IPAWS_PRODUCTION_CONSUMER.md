# Future IPAWS production normalized-alert consumer

This is a design contract, not an enabled production path. The staging receiver remains storage-only and cannot notify users.

## Contract and authorization boundary

The production receiver should emit a versioned immutable envelope only after SNS validation and CAP parsing:

```ts
interface NormalizedIpawsAlertV1 {
  schemaVersion: 1;
  source: "fema-ipaws";
  environment: "production";
  messageId: string;
  topicArn: string;
  identifier: string;
  sender: string | null;
  sentAt: string | null;
  messageType: "Alert" | "Update" | "Cancel" | "Ack" | "Error" | string | null;
  references: string[];
  event: string | null;
  severity: string | null;
  urgency: string | null;
  certainty: string | null;
  effectiveAt: string | null;
  expiresAt: string | null;
  areas: Array<{ description: string | null; polygons: string[]; circles: string[]; geocodes: Record<string, string[]> }>;
  contentDigest: string;
}
```

Ingress authorization and notification authorization must remain separate decisions. A valid FEMA message may be stored but must not notify until a production-only policy service authorizes its topic, CAP status/scope, geography, lifecycle state, freshness, severity, and target audience. Notification workers must accept only production envelopes from an authenticated production queue/service binding and must never treat a KV record as authorization.

## Environment isolation

- Use distinct production Worker name, domain/route, TopicArn allowlist, KV/D1/queue namespaces, Durable Object namespace or class migration, secrets, service bindings, logs, and alerting.
- Do not give the staging Worker any binding that can address a production queue, notification service, or production user database.
- Require `environment === "production"` at both queue publication and consumption. Reject `staging`, missing, or unknown values.
- Add a deployment-policy check that rejects production resource identifiers in the staging Wrangler file and staging identifiers in the production file.
- Keep `notificationsEnabled: false` in every staging schema and test this at the receiver and consumer boundary.

## Idempotency and the Durable Object/KV gap

The receiver's Durable Object serializes a MessageId claim and fences every lease mutation with an internal owner token, but the claim, KV write, normalized write, health update, and completion marker are separate cross-system operations. The token prevents an expired processor from mutating a newer lease; it is not a downstream idempotency key and does not make the cross-system workflow atomic. There is no atomic transaction across Durable Object storage and KV. A crash can therefore produce any of these states: claimed with no KV record, KV record without normalized record, normalized record before completion, or a completed claim whose ancillary health update failed. KV is also eventually consistent across locations.

The production consumer must own effect idempotency independently. Use a transactional inbox in the same strongly consistent database as notification jobs, with a unique key such as `(source, topicArn, messageId, consumerVersion)` and a separate unique effect key such as `(alertIdentifier, lifecycleVersion, audience, channel)`. In one transaction, record the inbox item and enqueue/outbox the authorized effects. Duplicate queue deliveries then observe the unique record and acknowledge without repeating effects.

Do not infer exactly-once behavior from the receiver. The end-to-end contract is at-least-once delivery plus exactly-once-effect protection at each side-effecting consumer.

## Retry and failure recovery

- Receiver failures before durable acceptance should return a retryable 5xx; permanent validation failures should return 4xx.
- Queue consumers should use bounded exponential backoff, a maximum-attempt policy, and a production DLQ.
- An operator replay tool should read the durable inbox/DLQ, preserve the original idempotency key, require an audit reason, and never bypass authorization.
- Reconciliation should compare accepted ingress records, normalized envelopes, inbox rows, outbox rows, and delivery receipts; gaps become alerts rather than silent skips.
- Partial receiver state whose lease expires can be retried. A reconciler should repair claimed/completed states that lack the expected normalized record.

## Alert lifecycle

Correlate CAP messages by sender plus identifier and use `references` for updates and cancellations. Persist every received version immutably. Compute a separate current-state projection with deterministic ordering by CAP `sent` time and a tie-breaker. `Update` replaces eligible current content; `Cancel` suppresses pending and future notification effects for referenced alerts; expired alerts become inactive; `Ack` and `Error` are stored but do not notify. Late or out-of-order versions must rebuild the projection without duplicating already-issued effects.

## Notification authorization

The authorizer should default deny. It must validate the approved FEMA feed, production environment, CAP `status`, `scope`, lifecycle type, target geography, freshness/expiry, required fields, and an approved notification policy version. Store the policy version and decision with every effect. Human or organizational approval for notification policy is required independently of this receiver's security review.

## Required tests before enabling production

- A staging envelope cannot be published to or accepted by the production consumer.
- A production envelope cannot be consumed without authenticated production transport and the explicit production environment marker.
- Concurrent duplicates, redelivery after crash, replay from DLQ, and out-of-order update/cancel events create no duplicate user effect.
- Authorization defaults deny for malformed, expired, test, draft, unsupported scope, irrelevant geography, and unknown lifecycle inputs.
- Reconciliation detects each modeled Durable Object/KV/queue partial failure.
