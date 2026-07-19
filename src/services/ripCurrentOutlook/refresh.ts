import { API_VERSION } from "../../config/version";
import type { Env } from "../../types";
import { fetchWithRetry, readResponseBytes, readResponseText } from "../../utils/http";
import { RIP_CURRENT_OUTLOOK_CACHE_KEY, ripCurrentOutlookImageKey } from "../cache/kv";
import type { RipCurrentOutlookMetadata } from "./types";

export const NWS_MOBILE_PAGE = "https://www.weather.gov/mob";
export const NWS_RIP_CURRENT_SOURCE_PAGE = "https://www.weather.gov/beach/mob";
export const RIP_CURRENT_MAX_BYTES = 10 * 1024 * 1024;
export const RIP_CURRENT_MIN_BYTES = 10 * 1024;
export const RIP_CURRENT_STALE_AFTER_MS = 36 * 60 * 60 * 1_000;
const EXPECTED_ALT = "5-Day Rip Current Outlook for Coastal Alabama and Northwest Florida";
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

class ImmutableRevisionUnavailableError extends Error {}

function nwsOnly(url: URL): void { if (url.hostname !== "www.weather.gov") throw new Error("unexpected_nws_host"); }
function attributes(tag: string): Map<string, string> {
	const result = new Map<string, string>();
	for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) result.set(match[1].toLowerCase(), match[3]);
	return result;
}
export function discoverRipCurrentImage(html: string): URL {
	const candidates = [...html.matchAll(/<img\b[^>]*>/gi)].map((match) => attributes(match[0])).filter((attrs) => (attrs.get("alt") ?? "").includes(EXPECTED_ALT));
	if (candidates.length !== 1) throw new Error("rip_current_image_discovery_failed");
	const src = candidates[0].get("src");
	if (!src) throw new Error("rip_current_image_discovery_failed");
	const url = new URL(src, NWS_MOBILE_PAGE);
	nwsOnly(url);
	if (!url.pathname.startsWith("/images/mob/")) throw new Error("unexpected_rip_current_image_path");
	return url;
}
function validImageSignature(bytes: Uint8Array, contentType: string): boolean {
	if (contentType === "image/png") return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte);
	if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
	if (contentType === "image/gif") return ["GIF87a", "GIF89a"].includes(new TextDecoder().decode(bytes.slice(0, 6)));
	if (contentType === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
	return false;
}
async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function cachedFallback(cached: RipCurrentOutlookMetadata, now: Date): RipCurrentOutlookMetadata {
	return { ...cached, status: "stale", freshness: "stale", usingCachedImage: true, lastRefreshAttempt: now.toISOString(), generatedAt: now.toISOString() };
}
export async function buildRipCurrentOutlookPayload(env: Env, now = new Date()): Promise<RipCurrentOutlookMetadata & { kvWrites?: Array<{ key: string; value: ArrayBuffer; options: KVNamespacePutOptions; expectedRevision: string }> }> {
	const cached = await env.BEACH_DATA.get<RipCurrentOutlookMetadata>(RIP_CURRENT_OUTLOOK_CACHE_KEY, "json");
	let immutableBackfillRequired = false;
	try {
		const pageResponse = await fetchWithRetry(NWS_MOBILE_PAGE, { validateUrl: nwsOnly, label: "NWS Mobile homepage" });
		if (!pageResponse.ok) throw new Error("nws_page_unavailable");
		const html = await readResponseText(pageResponse, { maxBytes: 2 * 1024 * 1024, contentTypes: ["text/html"] });
		const imageUrl = discoverRipCurrentImage(html);
		const conditionalHeaders = new Headers();
		if (cached?.upstreamETag) conditionalHeaders.set("If-None-Match", cached.upstreamETag);
		if (cached?.upstreamLastModified) conditionalHeaders.set("If-Modified-Since", cached.upstreamLastModified);
		let imageResponse = await fetchWithRetry(imageUrl, { headers: conditionalHeaders, validateUrl: nwsOnly, label: "NWS rip current outlook" });
		if (imageResponse.status === 304 && cached) {
			const storedRevision = await env.BEACH_DATA.getWithMetadata<{ revision?: string }>(ripCurrentOutlookImageKey(cached.revision), "arrayBuffer");
			if (storedRevision.value && storedRevision.metadata?.revision === cached.revision) {
				return { ...cached, status: "ok", freshness: "current", usingCachedImage: false, upstreamFetchTime: now.toISOString(), lastRefreshAttempt: now.toISOString(), generatedAt: now.toISOString() };
			}
			immutableBackfillRequired = true;
			imageResponse = await fetchWithRetry(imageUrl, { validateUrl: nwsOnly, label: "NWS rip current outlook migration body" });
			if (imageResponse.status === 304) throw new ImmutableRevisionUnavailableError("immutable_revision_missing_after_304");
		}
		if (!imageResponse.ok) throw new Error("nws_image_unavailable");
		const contentType = imageResponse.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		const bytes = await readResponseBytes(imageResponse, { maxBytes: RIP_CURRENT_MAX_BYTES, contentTypes: IMAGE_TYPES });
		if (bytes.byteLength < RIP_CURRENT_MIN_BYTES) throw new Error("rip_current_image_too_small");
		if (!validImageSignature(bytes, contentType)) throw new Error("invalid_rip_current_image");
		const revision = await sha256(bytes);
		const metadata: RipCurrentOutlookMetadata & { kvWrites?: Array<{ key: string; value: ArrayBuffer; options: KVNamespacePutOptions; expectedRevision: string }> } = {
			status: "ok", apiVersion: API_VERSION, provider: "National Weather Service Mobile/Pensacola", title: "Rip Current Outlook", imageUrl: "/v1/rip-current-outlook/image", sourceUrl: NWS_RIP_CURRENT_SOURCE_PAGE,
			upstreamFetchTime: now.toISOString(), upstreamLastModified: imageResponse.headers.get("Last-Modified") ?? undefined, upstreamETag: imageResponse.headers.get("ETag") ?? undefined,
			revision, contentType: contentType as RipCurrentOutlookMetadata["contentType"], freshness: "current", usingCachedImage: false, lastRefreshAttempt: now.toISOString(), generatedAt: now.toISOString(), count: 1,
		};
			const revisionKey = ripCurrentOutlookImageKey(revision);
			const storedRevision = cached?.revision === revision
				? await env.BEACH_DATA.getWithMetadata<{ revision?: string }>(revisionKey, "arrayBuffer")
				: null;
			if (cached?.revision !== revision || !storedRevision?.value || storedRevision.metadata?.revision !== revision) {
				const imageBuffer = new ArrayBuffer(bytes.byteLength);
				new Uint8Array(imageBuffer).set(bytes);
				metadata.kvWrites = [{ key: revisionKey, value: imageBuffer, options: { metadata: { revision, contentType } }, expectedRevision: revision }];
		}
		return metadata;
	} catch (error) {
		if (immutableBackfillRequired || error instanceof ImmutableRevisionUnavailableError) throw error;
		if (cached) return cachedFallback(cached, now);
		throw error;
	}
}
export function withComputedFreshness(metadata: RipCurrentOutlookMetadata, now = new Date()): RipCurrentOutlookMetadata {
	const age = now.getTime() - Date.parse(metadata.upstreamFetchTime);
	return !Number.isFinite(age) || age > RIP_CURRENT_STALE_AFTER_MS
		? { ...metadata, status: "stale", freshness: "stale", usingCachedImage: true }
		: metadata;
}
