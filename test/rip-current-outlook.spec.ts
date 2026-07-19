import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRipCurrentOutlookImageRequest, handleRipCurrentOutlookRequest } from "../src/routes/ripCurrentOutlook";
import { buildRipCurrentOutlookPayload, discoverRipCurrentImage, RIP_CURRENT_MAX_BYTES, withComputedFreshness } from "../src/services/ripCurrentOutlook/refresh";
import { ripCurrentOutlookImageKey } from "../src/services/cache/kv";
import type { RipCurrentOutlookMetadata } from "../src/services/ripCurrentOutlook/types";
import type { Env } from "../src/types";
const page = `<img src="/images/mob/graphicast/6.png" alt="5-Day Rip Current Outlook for Coastal Alabama and Northwest Florida. For more information.">`;
function png(size = 12_000) { const bytes = new Uint8Array(size); bytes.set([137,80,78,71,13,10,26,10]); return bytes; }
function imageResponse(bytes = png(), type = "image/png") { return new Response(bytes, { headers: { "Content-Type": type, ETag: '"upstream-1"', "Last-Modified": "Sat, 18 Jul 2026 12:00:00 GMT" } }); }
function cached(overrides: Partial<RipCurrentOutlookMetadata> = {}): RipCurrentOutlookMetadata { return { status: "ok", apiVersion: "1.0.0", provider: "National Weather Service Mobile/Pensacola", title: "Rip Current Outlook", imageUrl: "/v1/rip-current-outlook/image", sourceUrl: "https://www.weather.gov/beach/mob", upstreamFetchTime: "2026-07-18T12:00:00.000Z", upstreamETag: '"upstream-1"', revision: "abc", contentType: "image/png", freshness: "current", usingCachedImage: false, lastRefreshAttempt: "2026-07-18T12:00:00.000Z", generatedAt: "2026-07-18T12:00:00.000Z", count: 1, ...overrides }; }
function kv(metadata?: RipCurrentOutlookMetadata) { const bytes = png(); return { put: vi.fn(), get: vi.fn(async (key: string) => key === "rip-current-outlook" ? metadata ?? null : bytes.buffer), getWithMetadata: vi.fn(async (key: string) => ({ value: key === ripCurrentOutlookImageKey(metadata?.revision ?? "") ? bytes.buffer : null, metadata: { revision: metadata?.revision, contentType: "image/png" } })) }; }
function env(store: ReturnType<typeof kv>) { return { BEACH_DATA: store } as unknown as Env; }
afterEach(() => vi.restoreAllMocks());
describe("NWS rip current refresh", () => {
	it("narrowly discovers the labeled official image", () => { expect(discoverRipCurrentImage(page).href).toBe("https://www.weather.gov/images/mob/graphicast/6.png"); expect(() => discoverRipCurrentImage(`<img src="https://example.com/x.png" alt="5-Day Rip Current Outlook for Coastal Alabama and Northwest Florida">`)).toThrow(); });
	it("stages a verified new image under its immutable revision key", async () => { vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(page, { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(imageResponse())); const result = await buildRipCurrentOutlookPayload(env(kv())); expect(result.revision).toMatch(/^[a-f0-9]{64}$/); expect(result.kvWrites).toEqual([expect.objectContaining({ key: ripCurrentOutlookImageKey(result.revision), expectedRevision: result.revision })]); });
	it("handles conditional not-modified and identical content without writes", async () => { const prior = cached(); vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(page, { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(new Response(null, { status: 304 }))); expect((await buildRipCurrentOutlookPayload(env(kv(prior)))).kvWrites).toBeUndefined(); vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(page, { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(imageResponse())); const first = await buildRipCurrentOutlookPayload(env(kv())); vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(page, { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(imageResponse())); expect((await buildRipCurrentOutlookPayload(env(kv(cached({ revision: first.revision }))))).kvWrites).toBeUndefined(); });
	it("backfills an immutable object after a 304 when only the legacy image exists", async () => {
		const prior = cached();
		const store = kv(prior);
		store.getWithMetadata.mockResolvedValueOnce({ value: null, metadata: null });
		vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(page, { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(new Response(null, { status: 304 })).mockResolvedValueOnce(imageResponse()));
		const result = await buildRipCurrentOutlookPayload(env(store));
		expect(result.kvWrites).toEqual([expect.objectContaining({ key: ripCurrentOutlookImageKey(result.revision), expectedRevision: result.revision })]);
		expect(store.put).not.toHaveBeenCalled();
	});
	it("fails closed when a 304 migration cannot retrieve an image body", async () => {
		const prior = cached();
		const store = kv(prior);
		store.getWithMetadata.mockResolvedValueOnce({ value: null, metadata: null });
		vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(page, { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(new Response(null, { status: 304 })).mockResolvedValueOnce(new Response(null, { status: 304 })));
		await expect(buildRipCurrentOutlookPayload(env(store))).rejects.toThrow("immutable_revision_missing_after_304");
		expect(store.put).not.toHaveBeenCalled();
	});
	it.each([["HTML", () => new Response("<html>error</html>", { headers: { "Content-Type": "text/html" } })], ["wrong MIME", () => imageResponse(png(), "application/octet-stream")], ["undersized", () => imageResponse(png(100))], ["oversized", () => imageResponse(png(RIP_CURRENT_MAX_BYTES + 1))]])("rejects %s", async (_name, response) => { vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(page, { headers: { "Content-Type": "text/html" } })).mockResolvedValueOnce(response())); await expect(buildRipCurrentOutlookPayload(env(kv()))).rejects.toBeDefined(); });
	it("uses marked fallback on upstream failure and fails without cache", async () => { vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout"))); expect(await buildRipCurrentOutlookPayload(env(kv(cached())))).toMatchObject({ status: "stale", usingCachedImage: true }); await expect(buildRipCurrentOutlookPayload(env(kv()))).rejects.toBeDefined(); });
	it("normalizes age-derived stale metadata as last-known-good cached content", () => {
		expect(withComputedFreshness(cached(), new Date("2026-07-18T13:00:00.000Z"))).toMatchObject({ status: "ok", freshness: "current", usingCachedImage: false });
		expect(withComputedFreshness(cached(), new Date("2026-07-20T01:00:01.000Z"))).toMatchObject({ status: "stale", freshness: "stale", usingCachedImage: true });
	});
});
describe("rip current routes", () => {
	it("returns unavailable with no cache", async () => { expect((await handleRipCurrentOutlookRequest(env(kv()))).status).toBe(503); });
	it("serves matching image ETag and conditional 304", async () => { const store = kv(cached()); const image = await handleRipCurrentOutlookImageRequest(new Request("https://example.com/v1/rip-current-outlook/image"), env(store)); expect(image.headers.get("ETag")).toBe('"abc"'); expect(image.headers.get("Content-Type")).toBe("image/png"); const unchanged = await handleRipCurrentOutlookImageRequest(new Request("https://example.com/v1/rip-current-outlook/image", { headers: { "If-None-Match": '"abc"' } }), env(store)); expect(unchanged.status).toBe(304); });
	it("resolves only the published metadata revision and fails closed on mismatch", async () => {
		const store = kv(cached({ revision: "published" }));
		await handleRipCurrentOutlookImageRequest(new Request("https://example.com/v1/rip-current-outlook/image?revision=attacker"), env(store));
		expect(store.getWithMetadata).toHaveBeenCalledWith(ripCurrentOutlookImageKey("published"), "arrayBuffer");
		store.getWithMetadata.mockResolvedValueOnce({ value: png().buffer, metadata: { revision: "other", contentType: "image/png" } });
		expect((await handleRipCurrentOutlookImageRequest(new Request("https://example.com/v1/rip-current-outlook/image"), env(store))).status).toBe(503);
	});
	it("serves a matching legacy image during revision-key migration", async () => {
		const store = kv(cached());
		store.getWithMetadata.mockResolvedValueOnce({ value: null, metadata: null }).mockResolvedValueOnce({ value: png().buffer, metadata: { revision: "abc", contentType: "image/png" } });
		expect((await handleRipCurrentOutlookImageRequest(new Request("https://example.com/v1/rip-current-outlook/image"), env(store))).status).toBe(200);
		expect(store.getWithMetadata).toHaveBeenNthCalledWith(2, "rip-current-outlook:image", "arrayBuffer");
	});
});
