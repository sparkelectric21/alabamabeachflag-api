# General-production automatic deployment incident — 2026-10-02

## Classification

Unexpected but technically benign automatic deployment; production change-control review required. This record does not authorize rollback, integration changes, or another deployment.

## Timeline

| Event | UTC | America/Chicago |
|---|---|---|
| Previous version created | 2026-08-22 17:42:34.813 | 2026-08-22 12:42:34.813 CDT |
| Previous version activated | 2026-08-22 17:42:35.801 | 2026-08-22 12:42:35.801 CDT |
| PR #10 merge commit created | 2026-10-02 18:10:34 | 2026-10-02 13:10:34 CDT |
| GitHub verification started | 2026-10-02 18:10:40 | 2026-10-02 13:10:40 CDT |
| New Worker version created | 2026-10-02 18:10:53.136 | 2026-10-02 13:10:53.136 CDT |
| New version activated at 100 percent | 2026-10-02 18:10:54.101 | 2026-10-02 13:10:54.101 CDT |
| Cloudflare GitHub check completed | 2026-10-02 18:11:05 | 2026-10-02 13:11:05 CDT |
| GitHub verification completed | 2026-10-02 18:11:30 | 2026-10-02 13:11:30 CDT |

## Provenance

- Merge commit: `279a9e02706c0aa29edd2c282e7646d5eb01bba4`.
- Cloudflare build: `44de7903-3e65-4907-9df2-e28ca18b5065`.
- Resulting general-production version: `740ee4d0-d95d-496e-93c3-cf40864d0fce`.
- Resulting deployment: `205687fd-c0fd-456e-81e6-1872f24b8107`, 100 percent.
- Previous source commit: `5f728ed89546416e6fd98f6dcd4b07fea44e71cb`.
- Previous version: `e47ec17c-c798-44b1-9a09-da6a9fccc330`.

The GitHub check created by the Cloudflare Workers and Pages application directly associates the merge commit, build ID, Worker name, and resulting version. Cloudflare version metadata reports a Wrangler upload and deployment, which is consistent with Workers Builds invoking its configured deploy command. The repository GitHub Actions workflow was verification-only and used `--dry-run` for every Wrangler build. It had read-only repository permissions and no Actions secrets or variables.

The available identity metadata proves the credential context used by the integration, not that a named human intentionally authorized this deployment. Account audit logs, build-trigger settings, build-token metadata, deploy hooks, and GitHub App installation scope were inaccessible to the investigation credential and require separate read access.

## Change and impact

Both versions use the same compatibility date, `nodejs_compat` flag, standard usage model, `v2-verification-coordinator` migration tag, general-production KV and D1 resources, two Durable Object namespaces, routes, and secret names. The new version removed the disabled general-Worker IPAWS callback route, seven disabled IPAWS variables, and the IPAWS provider-health panel. It added no IPAWS Durable Object, TopicArn, route, secret, queue, service, or notification binding.

Aggregate-only analytics showed zero Worker errors in the hour before deployment and in the initial post-deployment sample. A later equal-duration comparison used `[2026-10-02T17:44:31Z, 2026-10-02T18:10:54Z)` and `[2026-10-02T18:10:54Z, 2026-10-02T18:37:17Z)`. The before/after samples contained 41/31 requests, 0/0 errors, 19/18 subrequests, CPU p50 2.457/2.142 milliseconds, CPU p99 50.488/21.625 milliseconds, wall-time p50 94.927/108.770 milliseconds, and wall-time p99 24.932/21.787 seconds. This does not show an obvious regression, but 26 minutes is not conclusive and traffic volume varies naturally. No request bodies, raw logs, URLs, identifiers, or synthetic requests were used.

## Local Git finding

Local `main` at `72c236ff3742cb724d0b8f41d2f649f6856f4db3` was 39 commits behind `origin/main`, not ahead. It was the merge base; it had zero unique commits, and `git cherry origin/main main` was empty. No unpublished local-main work was found and no ref was moved.

## Required follow-up

Before another merge to `main`, a Cloudflare production owner must inspect the Workers Builds trigger, build token, deploy hooks, production branch, path filters, build history, and account audit event. The repository recommendation is to upload an inactive version from `main` and require a separate approved promotion. If that is not compatible with the Worker's Durable Object contract, automatic production builds must be paused instead. See `IPAWS_PRODUCTION_RELEASE_GOVERNANCE.md`.

Rollback was not indicated by the available health evidence. If a production owner nevertheless authorizes rollback, the recorded prior target is `e47ec17c-c798-44b1-9a09-da6a9fccc330`; rollback would also restore the removed disabled IPAWS surface and therefore requires an explicit risk decision.
