import type { Env } from "../types";
import type { AdminIdentity } from "../services/admin/auth";
import { BEACH_EVENT_PROVIDERS } from "../beachEvents/providers";
import { refreshBeachEvents } from "../beachEvents/refresh";

const MAX_BODY_BYTES = 256;

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleProviderScopedBeachEventRefresh(request: Request, env: Env, identity: AdminIdentity, fetcher: typeof fetch = fetch): Promise<Response> {
	const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "application/json") return json({ error: "invalid_content_type" }, 415);
	const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return json({ error: "request_body_too_large" }, 413);
	let bodyText: string;
	try { bodyText = await request.text(); } catch { return json({ error: "invalid_request_body" }, 400); }
	if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) return json({ error: "request_body_too_large" }, 413);
	let body: unknown;
	try { body = JSON.parse(bodyText); } catch { return json({ error: "invalid_json" }, 400); }
	if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("providerId" in body) || typeof (body as { providerId?: unknown }).providerId !== "string") {
		return json({ error: "invalid_request" }, 400);
	}
	const providerId = (body as { providerId: string }).providerId;
	const provider = BEACH_EVENT_PROVIDERS.find((candidate) => candidate.id === providerId);
	if (!provider) return json({ error: "unknown_provider" }, 404);
	if (provider.mode === "disabled" || provider.mode === "manualOnly") return json({ error: "provider_unavailable" }, 409);
	const result = await refreshBeachEvents(env, new Date(), fetcher, { trigger: "admin", identity, scope: { mode: "provider", providerId } });
	if (result.outcome === "providerUnavailable") return json({ error: "provider_unavailable" }, 409);
	if (result.outcome === "duplicate") return json({ error: "refresh_in_progress", refresh: result.refresh }, 409);
	return json(result);
}
