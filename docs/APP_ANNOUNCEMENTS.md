# App announcements

App announcements are temporary, app-owned operational notices. They are deliberately separate from official NWS weather and emergency alerts and are never included in weather-alert or verification processing.

## Contract and behavior

`GET /v1/app-announcement` is public and read-only. It returns `{ "status": "ok", "announcement": null }` when no announcement is currently active. An active announcement contains `id`, server-generated `revision`, `title`, `message`, `severity`, `startsAt`, `expiresAt`, and nullable `actionTitle`/`actionUrl` fields. Severity is one of `information`, `notice`, `important`, or `critical`.

The source record is stored as plain JSON in the existing `BEACH_DATA` KV namespace under `app-announcement`. It is inactive before `startsAt`, after `expiresAt`, or after deletion. Public responses use a 60-second browser TTL, 180-second shared-cache TTL, and an ETag; matching `If-None-Match` requests receive 304. KV propagation can also take roughly one minute.

`PUT /internal/app-announcement` replaces the current record and creates a new revision. `DELETE /internal/app-announcement` clears it. Both require the existing Cloudflare Access identity/service-token policy; the legacy `x-refresh-secret` works only when the existing migration flag is explicitly enabled. Administrative responses are `no-store`.

The browser manager at `https://www.alabamabeachflag.com/admin/` or `https://alabamabeachflag.com/admin/` uses an authenticated Cloudflare Access browser session. It sends browser requests through the protected same-origin `/admin/service/` Worker route so Safari and other privacy-focused browsers do not need a cross-site authorization cookie. The direct Worker endpoint remains available for service-token clients. Announcement responses opt in only the two official website origins with credentialed CORS, and browser mutations with any other `Origin` are rejected.

Input is strict plain text: ID 1–128 characters, title 1–80, message 1–500, action title 1–40, UTC ISO-8601 start/expiration timestamps, and expiration later than start. Action links are HTTPS and limited by the comma-separated `APP_ANNOUNCEMENT_ACTION_HOSTS` configuration (default: `alabamabeachflag.com,www.alabamabeachflag.com`). Unexpected fields, markup/control characters, credentials in URLs, ports, fragments, unapproved hosts, and wording that presents the app notice as Apple, NWS/NOAA, police, government, or emergency services are rejected. Factual operational wording such as “NWS data is temporarily unavailable” remains allowed.

## Operations

Use a real Cloudflare Access service token or authenticated Access session in production. The placeholder below intentionally contains no credential:

```sh
curl -X PUT "$API_BASE/internal/app-announcement" \
  -H 'Content-Type: application/json' \
  -H 'CF-Access-Client-Id: <service-token-id>' \
  -H 'CF-Access-Client-Secret: <service-token-secret>' \
  --data '{"id":"provider-delay-2026-07-20","title":"Service Notice","message":"Beach flag updates may be delayed while we investigate an upstream provider issue.","severity":"important","startsAt":"2026-07-20T15:30:00Z","expiresAt":"2026-07-21T15:30:00Z","actionTitle":null,"actionUrl":null}'
```

Publishing and replacing use the same PUT; keep the stable ID when revising the same event. Schedule a future notice by setting a future `startsAt`; make every notice self-expire with `expiresAt`. Clear it with:

```sh
curl -X DELETE "$API_BASE/internal/app-announcement" \
  -H 'CF-Access-Client-Id: <service-token-id>' \
  -H 'CF-Access-Client-Secret: <service-token-secret>'
```

Confirm publication or expiration with `curl -i "$API_BASE/v1/app-announcement"`. After expiration, the public `announcement` is `null`; allow the documented cache/propagation interval when verifying a replacement or deletion.

The iOS app refreshes announcements on launch, pull-to-refresh, normal beach refresh, and foreground return after five minutes. It caches a last successful response locally, but shows a cached item only inside its valid time window. Failures are silent and cannot block beach data. Information, notice, and important notices are dismissible locally by revision; critical notices remain visible while active, and revised notices reappear. A future push feature can reuse the stable ID/revision contract, but no push fields or behavior exist today.
