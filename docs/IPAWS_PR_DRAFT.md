# Pull request draft

## Title

Prepare isolated IPAWS production ingress baseline

## Description

### Summary

Adds an inert, isolated production-ingress template and repository safety gates while preserving the deployed staging receiver. This PR does not deploy anything. Production ingestion, subscription confirmation, notifications, and downstream effects remain disabled.

### Architecture

The receiver validates the SNS envelope and exact TopicArn, bounds timestamp freshness, fetches a size- and time-bounded AWS SNS certificate without redirects, verifies the SNS signature, claims the MessageId through a dedicated Durable Object, safely parses CAP 1.2 XML, and stores authenticated results. Ingestion records now carry validated `staging` or `production` provenance, which normalization preserves. Matching legacy authenticated records are repaired automatically only in staging; production rejects environment-less records pending a separately authorized provenance migration. Ambiguous, malformed, or cross-environment records fail closed.

`src/ipaws/production-lifecycle.ts` models transactional Alert/Update/Cancel projection, per-lineage authorization, effect-decision idempotency, and relationship-based reconciliation. It is tested but is not called by the receiver runtime and cannot dispatch effects.

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
- Separate staging and production templates, strict crossover validation, and `notificationsEnabled: false`

The certificate model relies on Cloudflare TLS validation of the pinned AWS SNS origin and does not independently build a full X.509 chain. Independent security approval is required before production use; see `docs/IPAWS_SECURITY_REVIEW.md`.

### Test evidence

Local correction review used Node.js 24.21.0 and Wrangler 4.137.0. The complete suite passed 868 tests across 50 files, along with the general, staging, and IPAWS-production TypeScript and deterministic declaration checks; lint; deployment-policy template validation; expected rejection of unresolved real-deployment placeholders; staging and inert-production dry runs; whitespace checks; and production/development dependency-audit policies. GitHub evidence must refer to the exact reviewed head.

### Staging evidence

The staging Worker remains separately named and configured with staging KV, its Worker-scoped idempotency Durable Object, staging variables, and storage-only normalized records with notifications disabled. The production file contains placeholders and is rejected by real-deployment validation until independently reviewed values are supplied. This PR itself performs no deployment.

### Dependency audit

Wrangler was upgraded within major version 4 and safe transitive fixes were applied. The initial nine affected package entries were reduced to two moderate, development-only Vitest entries. The remaining fix requires a Vitest 5 semver-major upgrade and is deferred; the test server is not exposed in CI or production. Production dependencies have no reported advisories. Full paths and rationale are in `docs/IPAWS_SECURITY_REVIEW.md`.

### Known limitations

- Certificate trust depends on Cloudflare TLS authentication of the constrained AWS origin; there is no independent full-chain validation.
- SignatureVersion 1 requires legacy SHA-1 compatibility.
- Durable Object and KV writes are not a cross-system transaction; downstream effecting consumers must be independently idempotent.
- The actual SNS delivery policy must be recorded before selecting the production timestamp window.
- CAP lifecycle projection, per-lineage default-deny authorization, transactional effect-decision idempotency, and relationship-based reconciliation are modeled and tested, but are not integrated into the receiver runtime.
- Production transport, a provisioned strongly consistent lifecycle ledger, analytics access, and notification delivery are not implemented or enabled.
- Invalid-signature records retain bounded envelope metadata and a SHA-256 digest only; their untrusted message bodies are neither stored nor parsed.

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
