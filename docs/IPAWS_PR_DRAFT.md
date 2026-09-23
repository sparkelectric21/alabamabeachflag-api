# Pull request draft

## Title

Add hardened FEMA IPAWS staging SNS receiver

## Description

### Summary

Promotes the recovered and hardened FEMA IPAWS staging receiver into the canonical repository. It adds authenticated SNS ingestion, CAP parsing and staging storage, strongly consistent duplicate coordination, staging-only normalized records, tests, documentation, and a dedicated CI gate. This PR does not deploy anything and does not enable production notifications.

### Architecture

`POST /v1/ipaws/pubsub` validates the SNS envelope and exact TopicArn, bounds timestamp freshness, fetches a size- and time-bounded AWS SNS certificate without redirects, verifies the SNS signature, claims the MessageId through a staging Durable Object, safely parses CAP 1.2 XML, stores the receipt/parse result in staging KV, and writes a storage-only normalized staging record. Acquired, processing, and complete states use owner-token fencing for lease recovery and persisted-output repair. No queue, notification service, production user store, or production route is bound.

### Security controls

- Exact staging TopicArn allowlist and bounded request/parser sizes
- Configurable maximum message age and future clock skew
- Exact SNS hostname and certificate-path rules, HTTPS only, redirect rejection, and one deadline spanning headers through complete bounded body consumption
- Certificate date, leaf, identity, and RSA checks
- SNS SignatureVersion 1/SHA-1 and Version 2/SHA-256 verification
- Strongly consistent concurrent MessageId claim
- No success acknowledgement for active processing; completion requires output read-back
- Strict, namespace-aware CAP XML parsing with DTD/entity/complexity rejection
- Exact subscription action/topic/token matching; unsubscribe URLs are never fetched
- Retryable 503 classification for transient certificate and confirmation failures
- Token-fenced idempotency renew/complete/release operations; stale owners cannot mutate a replacement claim and produce a retryable 503 rather than a false acknowledgement
- Staging-only resources and `notificationsEnabled: false`

The certificate model relies on Cloudflare TLS validation of the pinned AWS SNS origin and does not independently build a full X.509 chain. Independent security approval is required before production use; see `docs/IPAWS_SECURITY_REVIEW.md`.

### Test evidence

Local review on Node.js 24.19.0 passed production and staging TypeScript checks, production and staging generated Worker type checks, static staging-surface linting, 80/80 focused IPAWS tests, 796/796 full-suite tests, changed-file whitespace checks (excluding Wrangler-generated declarations), production/all-dependency audit policy checks, and both production and staging Wrangler dry runs. Updated remote CI status should be recorded after the branch is pushed.

### Staging evidence

The recovered implementation corresponds to the staging architecture previously verified at deployed version `88b281b3-445b-48f1-924f-a29a5872cbca`: staging KV, staging idempotency Durable Object, staging IPAWS variables, and storage-only normalized records with notifications disabled. This PR itself performs no deployment.

### Dependency audit

Wrangler was upgraded within major version 4 and safe transitive fixes were applied. The initial nine affected package entries were reduced to two moderate, development-only Vitest entries. The remaining fix requires a Vitest 5 semver-major upgrade and is deferred; the test server is not exposed in CI or production. Production dependencies have no reported advisories. Full paths and rationale are in `docs/IPAWS_SECURITY_REVIEW.md`.

### Known limitations

- Certificate trust depends on Cloudflare TLS authentication of the constrained AWS origin; there is no independent full-chain validation.
- SignatureVersion 1 requires legacy SHA-1 compatibility.
- Durable Object and KV writes are not a cross-system transaction; downstream effecting consumers must be independently idempotent.
- The actual SNS delivery policy must be recorded before selecting the production timestamp window.
- CAP lifecycle projection, geographic authorization, production transport, DLQ/reconciliation, and notification authorization are deliberately not implemented.
- Invalid-signature payload retention should be reduced to bounded metadata before production.

### Reviewer checklist

- [ ] Confirm all resources and variables are staging-only.
- [ ] Confirm no production secret, binding, route, or notification path is present.
- [ ] Review SNS canonical signing and both signature versions.
- [ ] Independently approve or reject the certificate trust model.
- [ ] Confirm the FEMA TopicArn and actual SNS HTTP/S delivery policy.
- [ ] Review Durable Object migration safety and rollback procedure.
- [ ] Review the normalized-alert production consumer design before any implementation.
- [ ] Confirm dependency advisory dispositions and Node 24 CI evidence.
- [ ] Confirm the PR does not deploy or enable production notifications.

### Explicit scope statement

This PR does not merge or deploy production infrastructure, change production bindings or secrets, contact FEMA, or enable notifications to any user.
