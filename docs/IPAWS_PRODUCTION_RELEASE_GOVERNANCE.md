# IPAWS production release governance

## Current stop condition

Merging PR #10 produced repository commit `279a9e02706c0aa29edd2c282e7646d5eb01bba4`. Cloudflare Workers Builds then created general-production Worker version `740ee4d0-d95d-496e-93c3-cf40864d0fce` and activated it at 100 percent. GitHub check `Workers Builds: alabamabeachflag-api` directly associates Cloudflare build `44de7903-3e65-4907-9df2-e28ca18b5065`, that Worker version, and the merge commit. GitHub Actions run `37045668178` was a separate verification-only workflow; all of its Wrangler deployment commands used `--dry-run`.

The deployment removed the disabled IPAWS route and variables from the general Worker, retained the same routes, bindings, compatibility settings, and Durable Object migration tag, and showed no aggregate Worker errors in the bounded observation immediately after release. It was nevertheless outside the merge-only authorization. Do not merge this or another branch into `main` until the live Workers Builds production trigger has been separately reviewed and changed.

## Required Cloudflare change before another merge

The safest reversible configuration is:

1. Keep the Git connection so builds remain attributable to exact commits.
2. Change the general Worker's production deploy command from `npx wrangler deploy` to `npx wrangler versions upload --config wrangler.jsonc`.
3. Confirm the production branch is exactly `main`, record all path filters and deploy hooks, and require a separate explicit promotion to 100 percent.
4. If an inactive upload cannot preserve the Worker's current Durable Object contract, pause automatic production builds instead; do not silently fall back to live deployment.

This Cloudflare setting is an external production-control write. Repository changes cannot enforce it. A Cloudflare account owner must review the current trigger and build-token scope and explicitly approve the change. Rollback is restoring the recorded trigger configuration, but only after a separately approved test confirms it does not unexpectedly activate a version.

## Repository enforcement

`npm run validate:production-release-governance` structurally allowlists the two repository workflows and every property and step in the manual release. It rejects added triggers, jobs, actions, secret exposure, deployment-capable commands in verification CI, changes to the immutable-tree recheck, and changes to the exact deploy/readback commands. The ordinary `npm run deploy` entry point fails closed; the protected workflow is the only repository-defined live-deployment path.

The release workflow is intentionally inert until all of these external controls exist:

- the GitHub environment `ipaws-production` has required reviewers and deployment-branch protection limited to `main`;
- environment variable `IPAWS_PRODUCTION_RELEASE_ENABLED` is exactly `approved-disabled-baseline`;
- environment variable `CLOUDFLARE_ACCOUNT_ID` is configured;
- environment secret `CLOUDFLARE_API_TOKEN` is a dedicated least-privilege token;
- the production configuration contains independently verified values and passes deploy-mode policy validation;
- `config/ipaws-production-evidence.json` pins that exact configuration digest, contains a non-reversible digest for every independently reviewed evidence packet, and assigns every operational owner;
- the dispatch supplies the exact reviewed `main` commit, configuration SHA-256, evidence-manifest SHA-256, approval reference, and confirmation phrase.

The workflow deploys only `wrangler.ipaws.production.jsonc`. Immediately before deployment it rechecks the commit, remote `main`, both approved hashes, and the tracked working tree. Its first release must use `wrangler deploy` because the dedicated SQLite-backed Durable Object migration is an atomic resource operation. A sanitized readback then requires one version at 100 percent and exact compatibility, binding, variable, migration, route, and custom-domain state. The initial baseline remains unsubscribed and keeps ingestion, automatic subscription confirmation, notifications, and downstream effects disabled.

## Passive receiver boundary

The disabled baseline creates an isolated Worker, KV binding, route, and idempotency Durable Object but accepts no IPAWS messages while ingestion is false. Enabling passive ingestion is a later, separately approved change after FEMA/AWS subscription evidence is complete. Automatic subscription confirmation, notifications, and downstream effects remain separate approvals.

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

Run `npm run inventory:ipaws-production-inputs`. It emits only field names and status—never configured values, identifiers, evidence digests, owner names, or secrets. `-- --require-configured` is a fail-closed deployment gate for configuration-derived fields. `npm run validate:ipaws-production-evidence -- --require-complete` separately rejects missing evidence, owners, or a configuration-digest mismatch.
