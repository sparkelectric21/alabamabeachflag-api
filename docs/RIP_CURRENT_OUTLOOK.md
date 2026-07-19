# Rip Current Outlook

## Provider and discovery

The provider is the National Weather Service Mobile/Pensacola office. The refresher downloads `https://www.weather.gov/mob`, locates exactly one image whose `alt` text identifies the “5-Day Rip Current Outlook for Coastal Alabama and Northwest Florida,” resolves that image only on `www.weather.gov`, and requires its path to remain under `/images/mob/`. The current discovered path is `/images/mob/graphicast/6.png`, but it is not a configured dependency. The user-facing official source is `https://www.weather.gov/beach/mob`.

## API

- `GET /v1/rip-current-outlook` returns provider, title, backend image URL, official source URL, fetch time, upstream validators when present, SHA-256 revision, freshness, and cached-fallback state.
- `GET /v1/rip-current-outlook/image` serves only the verified outlook bytes. It supports `ETag`/`If-None-Match`, sends `nosniff`, and revalidates after five minutes.
- `POST /internal/refresh/rip-current-outlook` uses existing administrative authorization and requires an `Idempotency-Key`.

## Refresh, storage, and fallback

The existing six-hour scheduled job refreshes this daily product after water quality. Conditional requests avoid downloading unchanged images when NWS provides validators.

The existing `BEACH_DATA` KV namespace stores published metadata at `rip-current-outlook`, immutable images at `rip-current-outlook:image:<sha256-revision>`, and the independent verification result at `verification:rip-current-outlook:latest`. The public route temporarily reads the former `rip-current-outlook:image` object only when the immutable object is absent and its stored revision still matches published metadata; new writes never use that legacy key. KV is suitable because the accepted image is capped at 10 MiB, below Cloudflare KV’s current 25 MiB value limit. Images must be PNG, JPEG, GIF, or WebP, 10 KiB–10 MiB, and have a matching file signature.

For a changed SHA-256 revision, the coordinator writes the immutable revision image, reads it back to validate its revision metadata, and only then publishes metadata that references it. A failed image write or validation leaves the prior publication untouched. A failed metadata write can leave an unreferenced revision object, but the prior metadata and revision image remain usable. Unchanged revisions skip the image write when the immutable object already exists. If a conditional request returns `304 Not Modified` while the immutable object is absent, the refresh makes one bounded unconditional request for the body; only a successfully validated body can create the immutable object and proceed to metadata publication. If that body remains unavailable, the verified legacy publication stays readable and no metadata is published. Revision objects are not currently deleted; this avoids removing an active or immediately previous revision under KV eventual consistency and remains a future maintenance task.

Invalid content, unsafe hosts or redirects, page-structure changes, and upstream failures never replace known-good bytes. `upstreamFetchTime` is the time the currently published revision was last successfully retrieved or revalidated and is the model’s `lastSuccessfulFetchAt`/`verifiedAt` equivalent. `freshness: current` means that time is no more than 36 hours old and uses `usingCachedImage: false`. `freshness: stale` means no newer revision has been successfully verified within 36 hours; the backend is serving the last-known-good revision and sets `usingCachedImage: true`. An active upstream failure also produces that same coherent stale/cached state. `lastRefreshAttempt` records the latest attempt independently. With no verified image, both routes return a controlled `503`.

NWS can change its homepage label, markup, or image structure. Discovery intentionally fails safely and then requires parser review; the image endpoint never becomes a general proxy.

## Verification

The existing twice-daily duplicate-protected coordinator completes the unchanged Gulf Shores comparison and alert-state processing before it starts the independent outlook check. Each Rip Current metadata and image request has a five-second timeout. Timeout or failure is recorded only in `verification:rip-current-outlook:latest`; it cannot prevent Gulf Shores alert processing and is not connected to email alerting. The check validates schema, provider, official `weather.gov` source, explicit freshness/fallback state, image MIME, and revision agreement. Stale last-known-good content with a matching revision is a warning, while missing or inconsistent content fails.
