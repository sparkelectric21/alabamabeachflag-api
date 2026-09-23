# IPAWS SNS receiver independent security review package

## Recommended decision

Approve the staging receiver for continued staging use. Do not approve a production receiver solely from this review. Before production access, an independent security reviewer must explicitly accept the certificate trust model described below, the FEMA/AWS TopicArn and HTTP/S delivery policy must be recorded, and the production consumer boundary in `IPAWS_PRODUCTION_CONSUMER.md` must be implemented and reviewed.

## Exact certificate trust model

The receiver does not build and validate an X.509 chain itself. It accepts an SNS signing certificate only when all of these controls succeed:

1. `SigningCertURL` is HTTPS, contains no user information, non-default port, query, or fragment, and uses the exact host form `sns.<region>.amazonaws.com`.
2. Its path matches `/SimpleNotificationService-<token>.pem`.
3. `fetch` uses `redirect: "manual"`, so redirects are not followed. One five-second AbortController deadline remains active from request initiation through complete streamed-body consumption. The response must be successful and at most 96,000 bytes. Both declared length and streamed bytes are bounded; timed-out and over-limit streams are cancelled.
4. Cloudflare's outbound TLS implementation authenticates the HTTPS server name and its normal public PKI chain before returning the certificate body.
5. The downloaded object parses as X.509, is currently within `notBefore`/`notAfter`, is not a CA certificate, has an RSA public key, and has an SNS subject or Amazon/Starfield issuer identity.
6. The SNS canonical signing string verifies with RSA PKCS#1 v1.5. SignatureVersion 1 uses SHA-1, as required for AWS SNS compatibility; SignatureVersion 2 uses SHA-256. Other versions fail closed.

The trust anchor is therefore the Cloudflare-authenticated AWS HTTPS origin, not the issuer-name heuristic. The subject/issuer test is defense in depth and is not a substitute for chain validation.

## Residual risk requiring independent approval

The Worker does not independently validate the downloaded leaf against a bundled or platform CA store, verify every certificate in a chain, check revocation, or prove that the leaf chains to a specifically approved Amazon root. A compromise of the authenticated AWS SNS HTTPS origin, its public CA issuance, or Cloudflare's TLS validation could supply an attacker-controlled RSA leaf that passes the local identity checks. Conversely, an undocumented AWS change in certificate naming can fail closed and interrupt delivery.

SHA-1 remains enabled only for SNS SignatureVersion 1 interoperability. It is not used for general hashing, certificate trust, or newly designed signatures. A production approval should prefer SignatureVersion 2 when FEMA supports it, while retaining Version 1 only for the observed contract.

## Alternatives considered

- Full in-Worker chain construction against a pinned root bundle: stronger independent validation, but Cloudflare Web Crypto does not provide a complete general-purpose X.509 path validator; implementing one locally creates substantial parser and update risk.
- Pinning leaf certificates or public keys: rejects rotation and creates an availability risk unless AWS publishes a stable key set and rotation contract.
- Delegating validation to a separately operated verifier with a mature OS trust store: strongest practical independent validation, but adds a security-critical service, latency, availability, authentication, and operational ownership.
- Using an audited SNS signature-verification library that supports the Workers runtime: preferable if one is available and demonstrates URL constraints, redirect rejection, Version 1 compatibility, certificate validity, and chain validation without weakening the current controls.

## Timestamp policy

AWS documents three default HTTP/S retries with 20-second delays and permits custom HTTP/S delivery policies with no more than 3,600 seconds total retry time. The current one-hour maximum age is bounded and configurable, but it leaves no margin for initial queueing, retry jitter, or clock disagreement. Before production, obtain the actual subscription `DeliveryPolicy` and set `IPAWS_SNS_MAX_AGE_SECONDS` to the documented retry horizon plus an explicit margin. A two-hour value is the conservative recommendation when the policy is unknown; retain the five-minute future-skew limit. Strong MessageId idempotency limits replay effects, but does not make freshness checks optional.

Returning 400 for stale messages is intentionally permanent: AWS retries 5xx and 429 responses, while other errors are treated as permanent. Operations must therefore monitor stale rejections and use a DLQ or source replay procedure if the subscription supports one.

The exact signed timestamp spelling is preserved for canonical verification; freshness parsing never normalizes the signed value.

## Delivery recovery and confirmation safety

The coordinator distinguishes acquired work, an active processing lease, and verified completion. Each acquisition has a unique owner token; renew, complete, and release require the matching unexpired token and perform the comparison and mutation atomically. Stale owners receive HTTP 409 and cannot mutate a replacement claim, while the public handler converts lost ownership into retryable HTTP 503. The token is internal ephemeral security state and is not logged, persisted in alert/domain records, or returned to SNS. The handler renews after its initial durable write and immediately before notification completion. It never acknowledges active work as a duplicate. A complete marker is acknowledged only after expected KV output is readable; otherwise recovery reacquires and reconstructs missing output. Post-claim failures attempt a fenced release and lease expiry covers interruption before release. Durable Object and KV writes are not atomic, so the downstream transactional inbox/outbox requirement in `IPAWS_PRODUCTION_CONSUMER.md` remains mandatory.

Only `SubscriptionConfirmation` can cause an outbound GET. Its signed URL must contain exactly one case-sensitive `Action=ConfirmSubscription`, `TopicArn`, and `Token`, with topic and token equal to the signed envelope. `UnsubscribeConfirmation` is persisted and never fetched. Transient certificate or confirmation failures return 503; permanent validation failures return 4xx.

## CI and generated types

Production and staging Wrangler declarations are separate and checked independently. CI uses Node.js 24.19.0, pins actions by commit SHA, runs on pull requests and pushes to `main`, the integration branch, and this feature branch, and runs focused/full tests, both type checks, staging-surface linting, both Wrangler type checks, both dry runs, whitespace checks, and dependency audits. Dry runs do not upload or deploy versions.

## Dependency advisory disposition

The initial audit named nine package entries. All were development-only; `npm audit --omit=dev` found no production dependency advisory.

| Package | Dependency path | Disposition and exploitability |
| --- | --- | --- |
| `wrangler` | direct dev dependency | Upgraded from 4.105.0 to 4.137.0 within the existing major line. This removed its advisory chain. Not bundled into the Worker. |
| `miniflare` | `wrangler -> miniflare` | Resolved by Wrangler upgrade. Local/CI emulation only. |
| `sharp` | `wrangler -> miniflare -> sharp` | Resolved by Wrangler upgrade. The vulnerable image codec was not called by application code. |
| `undici` | `wrangler -> miniflare -> undici` | Resolved by Wrangler upgrade. The affected HTTP client was tooling-only, not the Worker's runtime `fetch`. |
| `postcss` | `vitest -> vite -> postcss` | Safely upgraded to 8.5.28. The arbitrary source-map read required attacker-controlled CSS processed by the test toolchain and was not reachable from the deployed Worker. |
| `nanoid` | `vitest -> vite -> postcss -> nanoid` | Safely upgraded to 3.3.19. The denial-of-service cases required invalid sizes passed to custom/non-secure generators; application code does not import it. |
| `esbuild` | `vitest -> vite -> esbuild` | Safely upgraded to 0.28.2. The reported issue required a Windows development server and a local authenticated attacker; CI is Linux and no development server is exposed. |
| `@vitest/mocker` | `vitest -> @vitest/mocker` | Deferred. The available automatic fix upgrades Vitest to 5.0.1, a semver-major change. The issue requires access to Vitest's mock development server and a crafted redirect; CI runs one-shot tests without exposing that server. |
| `vitest` | direct dev dependency, via `@vitest/mocker` | Deferred with the same rationale. Upgrade to Vitest 5 should be a separate compatibility-tested change or explicitly approved for this branch. |

After the safe upgrades, the full audit reports two moderate development-only findings (`vitest` and `@vitest/mocker`), zero high or critical findings, and zero production findings. CI enforces both a high-severity production audit and a no-critical all-dependency audit without pretending the two accepted moderate findings are fixed.

## Other review observations

- The committed PEM private key is a generated test fixture used only to create deterministic signatures. It is not trusted externally and is not a production secret.
- The staging Wrangler file names only the staging Worker, staging KV namespace, staging Durable Object, and staging variables. It has no production route, queue, service, user store, notification binding, or production secret.
- Invalid-signature bodies are currently retained in staging KV for diagnostics until TTL expiry. They are size bounded, but this permits unauthenticated storage consumption. Production should retain only bounded metadata/digests for invalid deliveries or apply a rate/storage control.
- The idempotency coordinator and KV are not one transaction. See the production consumer design for the required downstream constraints.
