# IPAWS production release governance

## Current deployment boundary

The general-production incident and its attribution remain recorded below, but the automatic-activation path has been corrected. Workers Builds now uses `npx wrangler versions upload --config wrangler.jsonc`, so a matching `main` build may create an inactive general-Worker version without changing traffic. The active general-production version remains `740ee4d0-d95d-496e-93c3-cf40864d0fce`; the upload associated with merged PR #11 remained inactive.

Merging PR #10 had activated the general Worker outside the merge-only authorization. That deployment removed the disabled IPAWS route and variables from the general Worker, retained the same routes, bindings, compatibility settings, and Durable Object migration tag, and showed no aggregate Worker errors in the bounded observation immediately after release. The repository still treats verification CI and any production release as separate operations.

## General-Worker build control

Cloudflare documents `npx wrangler versions upload` as the supported way to keep automatic builds while preventing automatic production activation. The configured control is:

1. Keep the Git connection so builds remain attributable to exact commits.
2. In **Workers & Pages → alabamabeachflag-api → Settings → Builds**, keep the production Deploy command exactly `npx wrangler versions upload --config wrangler.jsonc`.
3. Confirm the production branch is exactly `main`, record all path filters and deploy hooks, and require a separate explicit promotion to 100 percent.
4. Do not trigger a test build as part of the setting change. If inactive upload cannot preserve the Worker's Durable Object contract, disconnect Workers Builds instead; do not silently fall back to live deployment.

This Cloudflare setting is an external production control that repository checks cannot enforce. William Dickens, as account owner, recorded and verified the command, production branch, filters, token identity/scope, and active deployment. Restoring the old deploy command would re-enable automatic activation on the next matching push and therefore requires separate approval.

## Repository enforcement

`npm run validate:production-release-governance` structurally allowlists the two repository workflows and every property and step in the manual release. It rejects added triggers, jobs, actions, secret exposure, deployment-capable commands in verification CI, changes to the immutable-tree recheck, and changes to the exact deploy/readback commands. The ordinary `npm run deploy` entry point fails closed; the protected workflow is the only repository-defined live-deployment path.

The release workflow is intentionally inert until all of these external controls exist:

- the GitHub environment `ipaws-production` is limited to `main`; this sole-owner project uses explicit confirmation and immutable evidence gates rather than a nonexistent second account;
- environment variable `IPAWS_PRODUCTION_RELEASE_ENABLED` is exactly `approved-disabled-baseline`;
- environment variable `CLOUDFLARE_ACCOUNT_ID` is configured;
- environment secret `CLOUDFLARE_API_TOKEN` is a dedicated least-privilege token;
- environment secret `IPAWS_METRICS_READ_TOKEN` contains at least 32 random bytes and is exposed only to the atomic deployment step;
- the production configuration contains independently verified values and passes deploy-mode policy validation;
- `config/ipaws-production-disabled-baseline-evidence.json` pins the exact disabled configuration, contains only pre-endpoint evidence, and assigns every operational owner;
- the dispatch supplies the exact reviewed `main` commit, configuration SHA-256, evidence-manifest SHA-256, approval reference, and confirmation phrase.

For the first deployment only, the time-limited release token has **Account → Workers Scripts → Edit** on the approved account because a nonexistent Worker cannot yet be selected as a per-Worker resource, plus **Zone → Workers Routes → Edit** scoped only to `alabamabeachflag.com`. Binding the already-created KV namespace does not require KV data permission. No DNS, KV Storage, R2, D1, Queues, Tail, account-membership, billing, or unrelated permission belongs on this token. After bootstrap and readback, replace it with a credential scoped only to `alabamabeachflag-ipaws-production` plus the same zone-scoped Workers Routes permission for releases that may change the route. A separate aggregate-analytics read token remains preferable for monitoring and must not be reused as the release credential.

The workflow deploys only `wrangler.ipaws.production.jsonc`. Immediately before deployment it refetches and rechecks remote `main`, the commit, both approved hashes, and the complete working tree. Its first release must use `wrangler deploy` because the dedicated SQLite-backed Durable Object migration is an atomic resource operation. The wrapper refuses to invoke Wrangler unless the metrics token is at least 32 bytes, writes it to a mode-0600 temporary file, supplies that file with `--secrets-file` to the same first deployment, removes it in a `finally` block, and never prints the value. This avoids `wrangler secret put`, which would create and immediately deploy a version before the reviewed baseline sequence. The wrapper applies the approved commit as a version tag and captures the returned version ID without printing it. Sanitized readback then requires that exact tagged version alone at 100 percent, exact compatibility and migration settings, the exact KV identity, an isolated Durable Object namespace and class, exact plain variables, exactly one named metrics secret of secret type, the exact route, and no custom domain. The initial baseline remains unsubscribed and keeps ingestion, automatic subscription confirmation, notifications, and downstream effects disabled.

## Passive receiver boundary

The disabled baseline creates an isolated Worker, KV binding, route, and idempotency Durable Object with an empty TopicArn allowlist. Because ingestion is false, callback POSTs fail before body reading, SNS parsing, certificate retrieval, storage, metrics mutation, normalization, or acknowledgement. The endpoint can be supplied to FEMA without accepting a production notification. FEMA must provide the exact production TopicArn before any later allowlist or ingestion change. Automatic subscription confirmation, notifications, and downstream effects remain separate approvals.

`src/ipaws/production-lifecycle.ts` is a modeled consumer contract only. The passive receiver does not call it, no lifecycle-ledger resource is bound, and no effect transport exists. A strongly consistent lifecycle ledger is not required to authenticate and retain passive ingress while all effects are disabled. It is deferred to the consumer/effects phase and requires its own design, provisioning, migration, integration, and review.

## Monitoring and acceptance

Use hour-aligned inclusive-start/exclusive-end UTC windows. Compare the receiver's sanitized aggregate request count with `workersInvocationsAdaptive.sum.requests` for the dedicated production Worker after analytics lag. Queries may request only aggregate request/error/subrequest totals and CPU/wall-time quantiles.

For every disabled-baseline and later passive-ingress gate require:

- zero Worker errors, privacy leaks, unexpected exceptions, subscription changes, environment crossover, binding/route/version drift, or metrics-caused response changes;
- exact request-total reconciliation after analytics lag;
- every authenticated request has one terminal receiver outcome;
- unsupported authenticated structures use only fixed aggregate classes;
- no normalization for unsupported structures and no downstream effect;
- latency is compared with a recorded baseline; any sustained p99 regression over 50 percent pauses progression.

Pause immediately for any privacy exposure, nonzero Worker errors attributable to the release, unexplained 5xx response, request/counter mismatch, missing terminal outcome, unexpected parser class, subscription drift, or production/staging resource crossover. Roll back only to the recorded dedicated IPAWS production disabled-baseline version. A Worker rollback does not revert KV or Durable Object state.

## Machine-readable missing inputs

Run `npm run inventory:ipaws-production-inputs` for the disabled baseline. It emits only field names and status—never configured values, identifiers, evidence digests, owner names, or secrets. The TopicArn reports `deny_all_pending_fema`, which is mandatory in this phase. `npm run validate:ipaws-production-evidence -- --require-complete` rejects missing pre-endpoint readiness, ownership, or a configuration-digest mismatch, but deliberately has no FEMA/SNS fields.

Run `npm run inventory:ipaws-passive-ingestion-inputs` and `npm run validate:ipaws-passive-ingestion-evidence -- --require-complete --baseline-config=<preserved-baseline-config>` only for the later passive-ingestion change. That phase requires a nonempty reviewed TopicArn, explicit ingestion enablement, the complete distinct baseline manifest, the exact preserved baseline configuration, an independently verified baseline deployment-readback packet, and every FEMA/SNS delivery fact. It rejects an empty allowlist, enabled automatic confirmation, notifications, downstream effects, phase-swapped manifests, altered owners, reused evidence packets, missing requirements, and `not-applicable` markers. Every evidence hash is recomputed from its phase, requirement name, and packet digest. William Dickens is the required sole owner for every operational role. Exact-commit pinning, passing CI, manual confirmation, hashes, clean-tree enforcement, rollback safeguards, and independent technical review are the compensating sole-owner controls.
