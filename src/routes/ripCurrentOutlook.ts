import type { Env } from "../types";
import { RIP_CURRENT_OUTLOOK_CACHE_KEY, RIP_CURRENT_OUTLOOK_LEGACY_IMAGE_KEY, ripCurrentOutlookImageKey } from "../services/cache/kv";
import { withComputedFreshness } from "../services/ripCurrentOutlook/refresh";
import type { RipCurrentOutlookMetadata } from "../services/ripCurrentOutlook/types";
export async function handleRipCurrentOutlookRequest(env: Env): Promise<Response> {
	const metadata = await env.BEACH_DATA.get<RipCurrentOutlookMetadata>(RIP_CURRENT_OUTLOOK_CACHE_KEY, "json");
	if (!metadata) return Response.json({ status: "unavailable", message: "No verified rip current outlook is available." }, { status: 503, headers: { "Cache-Control": "no-store" } });
	return Response.json(withComputedFreshness(metadata), { headers: { "Cache-Control": "public, max-age=300, stale-if-error=3600" } });
}
export async function handleRipCurrentOutlookImageRequest(request: Request, env: Env): Promise<Response> {
	const metadata = await env.BEACH_DATA.get<RipCurrentOutlookMetadata>(RIP_CURRENT_OUTLOOK_CACHE_KEY, "json");
	if (!metadata) return Response.json({ status: "unavailable", message: "No verified rip current outlook image is available." }, { status: 503, headers: { "Cache-Control": "no-store" } });
	let stored = await env.BEACH_DATA.getWithMetadata<{ revision?: string; contentType?: string }>(ripCurrentOutlookImageKey(metadata.revision), "arrayBuffer");
	if (!stored.value) stored = await env.BEACH_DATA.getWithMetadata<{ revision?: string; contentType?: string }>(RIP_CURRENT_OUTLOOK_LEGACY_IMAGE_KEY, "arrayBuffer");
	if (!stored.value || stored.metadata?.revision !== metadata.revision) return Response.json({ status: "unavailable", message: "No verified rip current outlook image is available." }, { status: 503, headers: { "Cache-Control": "no-store" } });
	const etag = `"${metadata.revision}"`;
	const headers = { "Content-Type": metadata.contentType, "Cache-Control": "public, max-age=300, must-revalidate", ETag: etag, "X-Content-Type-Options": "nosniff" };
	if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });
	return new Response(stored.value, { headers });
}
