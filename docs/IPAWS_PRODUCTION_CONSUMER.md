# Future IPAWS production normalized-alert consumer

This is a design contract, not an enabled production path. The staging receiver remains storage-only and cannot notify users.

`wrangler.ipaws.production.jsonc` is an inert repository template, not an approved deployment configuration. Its Worker, KV, route, endpoint, and TopicArn values are recognizable placeholders. `npm run validate:ipaws-production-deploy` must fail until an operator replaces every placeholder with independently verified production identifiers. The initial baseline must keep ingestion, automatic subscription confirmation, notifications, and downstream effects set to `false` and must contain no queue, email, service, D1, R2, AI, or asset binding.

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

The repository provides deterministic lifecycle projection, default-deny authorization, a transactional ledger contract for inbox/version/projection/effect-decision writes, and reconciliation set comparison in `src/ipaws/production-lifecycle.ts`. This module is modeled and tested but is not called by the receiver runtime. These are prerequisites, not an enabled consumer: a strongly consistent production store and its binding still require separate approval, provisioning, and integration. The stored “effect” is only an idempotent authorization-decision record; no user-facing transport is implemented.

## Required operator and FEMA inputs

Supply and independently verify all of the following without placing credentials in source control:

- exact production SNS TopicArn and AWS partition/region;
- whether automatic subscription confirmation is approved, who initiates it, and the change window;
- dedicated production Worker name, KV namespace ID, route/zone, endpoint, and Durable Object ownership;
- the Cloudflare account and operator authorized to deploy and roll back;
- a secret binding named `IPAWS_METRICS_READ_TOKEN` containing a newly generated value of at least 32 bytes;
- a read-only Cloudflare API token with `Account Analytics: Read`, its custodian, and expiry/rotation owner;
- incident commander, privacy reviewer, monitoring owner, FEMA liaison, and rollback operator;
- confirmation whether authenticated JSON arrays, scalar JSON, or opaque text are expected auxiliary FEMA messages.

## Disabled production baseline

1. Replace every placeholder in `wrangler.ipaws.production.jsonc` with approved production identifiers. Do not reuse staging identifiers.
2. Keep `IPAWS_INGESTION_ENABLED`, `IPAWS_AUTO_CONFIRM_SUBSCRIPTION`, `IPAWS_NOTIFICATIONS_ENABLED`, and `IPAWS_DOWNSTREAM_EFFECTS_ENABLED` set to `false`.
3. Provision only the approved production KV namespace, Worker route, metrics secret, and dedicated SQLite Durable Object namespace. Resource creation is a separate authorized change.
4. Run the full Node.js 24 suite, all declaration checks, `npm run validate:ipaws-production-deploy`, audits, and the production-template dry run.
5. Review resolved dry-run bindings against the approved inventory. Verify the staging config contains none of the production identifiers.
6. After explicit approval, deploy the disabled baseline with `wrangler deploy`; a new Durable Object lifecycle migration cannot be introduced with `wrangler versions upload`.
7. Record the resulting version as the production IPAWS rollback target before uploading any enabled candidate.

## Independent analytics denominator

Use a least-privilege token with Cloudflare `Account Analytics: Read` to query `workersInvocationsAdaptive` for the dedicated production script and canonical inclusive-start/exclusive-end UTC windows. Retain only aggregate invocation, outcome, error, and latency values. Compare the independent invocation denominator with the aggregate receiver request count after excluding documented operator probes. Any unexplained difference pauses rollout; receiver metrics alone are best-effort and can undercount.

## Initial canary and acceptance gates

The first Durable Object lifecycle deployment is atomic and cannot be percentage-canary deployed. Deploy it disabled and unsubscribed. Upload the enabled version only after that baseline exists, initially place it at 0%, and verify version metadata and bindings. Because an SNS subscription cannot safely split confirmation attempts between a disabled and enabled receiver, the initial traffic canary is gated by naturally arriving volume rather than a mixed enabled/disabled percentage: first 10 deliveries, then 100, then 1,000, with minimum observation periods of one hour, four hours, and 24 hours. Later code-only releases may use `1% → 5% → 25% → 50% → 100%` when Worker/Durable Object APIs remain forward- and backward-compatible.

Every gate requires zero privacy leakage, unexpected exceptions, unexplained 5xx responses, security regressions, normalization gaps, subscription drift, or configuration drift. Cloudflare request analytics and receiver request totals must reconcile exactly after documented probes. Unsupported input classes must be understood and bounded; an unknown parser failure pauses rollout. User-facing notifications and downstream effects remain disabled.

## Pause and rollback

Pause immediately for privacy exposure, staging/production resource crossover, an analytics mismatch, a subscription-state change, an unknown input/parser class, missing normalized output, unexpected 5xx response, latency regression, or version/binding/route drift. Roll back only to the recorded disabled production IPAWS baseline. Never use the general production API version or a staging version as the IPAWS rollback target.

Worker rollback restores the selected code and binding version but does **not** revert KV, Durable Object, D1, queue, or other storage state. After rollback, keep the SNS subscription paused or removed under its separately approved procedure, reconcile retained ingress/lifecycle/inbox/effect-decision state, and preserve evidence for review.
