# IPAWS production disabled-baseline bootstrap evidence

This packet records only sanitized pre-deployment evidence observed on 2026-10-02. It contains no Cloudflare account identifier, API-token value, KV identifier, request payload, SNS identifier, or secret value.

## External readiness

- DNS: `ipaws.alabamabeachflag.com` has one proxied AAAA record targeting Cloudflare's documented non-serving Worker-only placeholder `100::`. No Worker route exists. A bounded HEAD check returned Cloudflare `522`, so no application origin was exposed.
- Original GitHub environment: `ipaws-production` is restricted to `main` and remains unchanged with the expected bootstrap and metrics secret names plus the `CLOUDFLARE_ACCOUNT_ID` variable. Its release-enable variable is absent.
- Release environment: `ipaws-production-release` is restricted to `main`, has no reviewers, wait timer, or custom protection rules, and now contains only `CLOUDFLARE_ACCOUNT_ID` plus the protected `CLOUDFLARE_API_TOKEN` and `IPAWS_METRICS_READ_TOKEN` secret names. `IPAWS_PRODUCTION_RELEASE_ENABLED` remains absent, so the workflow stays fail closed.
- Release credential: `IPAWS production release bootstrap` expires on 2026-10-09 and is scoped only to the approved account and `alabamabeachflag.com`, with Account Workers Scripts edit and Zone Workers Routes edit. It has no DNS, KV-data, D1, R2, Queues, AI, billing, membership, account-administration, or unrelated permission. Its value was transferred directly to GitHub and is not recorded, hashed, or retrieved here.
- Runner diagnostic: GitHub Actions run `37072027774` on merged commit `be2425df4be38be9d31174cf0ef88231484b9a74` acquired `ubuntu-latest`, completed checkout, and stopped at `Validate immutable approval inputs` because the release gate was absent. Every setup, test, Wrangler, Cloudflare, deployment, and verification step after that gate was skipped.
- Analytics: the authenticated Cloudflare account dashboard displayed aggregate Worker invocation, Worker error, and CPU-time metrics. No request body or log access was used. A dedicated read-only automation credential with `Account Analytics: Read` is still unprovisioned and must not reuse the release credential.
- Ownership: `config/ipaws-production-disabled-baseline-evidence.json` assigns monitoring, privacy, incident response, FEMA coordination, secret custody, and rollback to `william-dickens`.

The machine-readable packets under `config/ipaws-production-evidence/` are deliberately separate so every evidence requirement has a unique packet digest. They omit secret values and protected resource identifiers.

The reviewed production configuration SHA-256 is `e2e454cc0420bad47339076aa493e9f0365cc0809a0d8a17abbed76d89d21479`. The complete disabled-baseline evidence manifest SHA-256 is `9a9ac856e2e48d84b6ec714b81189f348a90b8e930271966ac9ce70b65ce2b5b`. These immutable file digests are supplied as manual workflow inputs after merge; neither is a secret or a substitute for exact-head approval.

## Metrics-secret bootstrap ordering

Cloudflare documents that `wrangler secret put` creates a Worker version and deploys it immediately. It is therefore forbidden for the nonexistent production Worker. The first reviewed release instead requires a protected GitHub environment secret named `IPAWS_METRICS_READ_TOKEN` containing at least 32 random bytes. The manual workflow exposes it only to the deploy step. The deployment wrapper refuses to invoke Wrangler when it is absent or too short, writes it to a mode-0600 temporary JSON file, supplies it with `wrangler deploy --secrets-file` during the same first release that creates the Worker and applies the Durable Object migration, and deletes the temporary directory in a `finally` block. Post-deployment readback requires the binding to exist as `secret_text`.

The metrics secret was generated from 32 bytes of operating-system cryptographic randomness and stored directly as the protected `IPAWS_METRICS_READ_TOKEN` GitHub environment secret. Its value was not printed, retrieved for verification, hashed, or retained in this repository. Only the secret name and readiness metadata are recorded.

Exact-head acceptance is intentionally external to this manifest. After this evidence change is merged and independently reviewed, the final `main` SHA is supplied as the manual workflow's required `approved_commit` input together with the reviewed configuration and evidence digests. The workflow checks all three values against the checked-out `main` tree before credentials are exposed. This avoids a self-referential commit field. No final commit, digest, release-enable value, or approval reference is stored prematurely in the GitHub environment.

An independent technical review approved the final evidence contract, phase separation, secret-readiness representation, and exact-head design. The review packet records its scope and verdict without embedding a commit identifier or secret-derived material.
