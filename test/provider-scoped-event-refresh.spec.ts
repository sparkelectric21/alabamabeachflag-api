import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { refreshBeachEvents, REFRESH_STATUS_KEY } from "../src/beachEvents/refresh";
import { handleProviderScopedBeachEventRefresh } from "../src/routes/refreshBeachEventsProvider";
import { EVENT_PREFIX, normalizedEvent, SNAPSHOT_KEY } from "../src/beachEvents/store";
import type { BeachEventsSnapshot, SourceFacts } from "../src/beachEvents/types";
import type { Env } from "../src/types";
import { defaultOperationalControl } from "../src/operationalControl/store";

function memoryEnv() {
	const values = new Map<string, string>();
	const kv = {
		get: vi.fn(async (key: string, type?: string) => { const value = values.get(key); return value === undefined ? null : type === "json" ? JSON.parse(value) : value; }),
		put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
		delete: vi.fn(async (key: string) => { values.delete(key); }),
		list: vi.fn(async ({ prefix }: { prefix: string }) => ({ keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true })),
	};
	return { env: { BEACH_DATA: kv, APP_ENVIRONMENT: "staging", VERIFICATION_ALERT_ENVIRONMENT: "staging", HISTORICAL_DATA_ENVIRONMENT: "staging", STAGING_LIVE_PROVIDER_FETCH_ENABLED: "true", ALLOW_LEGACY_REFRESH_SECRET: "true", REFRESH_SECRET: "test-secret", BEACH_ACTIVITY_NOTIFICATIONS_ENABLED: "false" } as unknown as Env, values };
}

const calendar = (uid = "gsp-1") => ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", `UID:${uid}`, "SUMMARY:Beach Pavilion Program", "LOCATION:Beach Pavilion", "DTSTART:20260901T150000Z", "DTEND:20260901T160000Z", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const component = (uid: string, valid = true) => ["BEGIN:VEVENT", ...(valid ? [`UID:${uid}`] : []), `SUMMARY:Program ${uid}`, "LOCATION:Beach Pavilion", "DTSTART:20260901T150000Z", "DTEND:20260901T160000Z", "END:VEVENT"].join("\r\n");
const mixedCalendar = (valid: number, invalid: number) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...Array.from({ length: valid }, (_, index) => component(`valid-${index}`)), ...Array.from({ length: invalid }, (_, index) => component(`invalid-${index}`, false)), "END:VCALENDAR"].join("\r\n");

function request(body: unknown, headers: Record<string, string> = {}) {
	return new Request("https://example.com/internal/refresh/beach-events/provider", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("provider-scoped beach-event refresh", () => {
	it("fetches only Gulf State Park and records provider scope", async () => {
		const h = memoryEnv();
		const fetcher = vi.fn(async () => new Response(calendar(), { headers: { "Content-Type": "text/calendar" } }));
		const response = await handleProviderScopedBeachEventRefresh(request({ providerId: "gulfStatePark" }), h.env, { method: "access", subject: "operator" }, fetcher as unknown as typeof fetch);
		expect(response.status).toBe(200);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(String(fetcher.mock.calls[0][0])).toContain("calendar.google.com");
		const payload = await response.json() as { refresh: { scope: unknown; providers: Array<{ providerId: string }> } };
		expect(payload.refresh.scope).toEqual({ mode: "provider", selectedProviderId: "gulfStatePark", requestedProviderCount: 1, attemptedProviderCount: 1 });
		expect(payload.refresh.providers.map((provider) => provider.providerId)).toEqual(["gulfStatePark"]);
		expect(JSON.parse(h.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ scope: { mode: "provider", selectedProviderId: "gulfStatePark", attemptedProviderCount: 1 } });
		expect([...h.values.keys()].filter((key) => key.includes("ical-state:"))).toEqual(["beach-events:v1:ical-state:gulfStatePark"]);
	});

	it.each(["GulfStatePark", " gulfStatePark", "gulfStatePark ", "../gulfStatePark", "https://example.com"])("rejects noncanonical provider ID %s before writes", async (providerId) => {
		const h = memoryEnv();
		const response = await handleProviderScopedBeachEventRefresh(request({ providerId }), h.env, { method: "access", subject: "operator" }, vi.fn() as unknown as typeof fetch);
		expect(response.status).toBe(404);
		expect(h.values.size).toBe(0);
	});

	it.each(["dauphinIslandTown", "alabamaCoastalCleanup", "dauphinIslandSeaLab"])("rejects non-fetchable provider %s before writes", async (providerId) => {
		const h = memoryEnv();
		const response = await handleProviderScopedBeachEventRefresh(request({ providerId }), h.env, { method: "access", subject: "operator" }, vi.fn() as unknown as typeof fetch);
		expect(response.status).toBe(409);
		expect(h.values.size).toBe(0);
	});

	it("rejects malformed bodies and extra fields", async () => {
		for (const body of ["{", [], { providerId: "gulfStatePark", other: true }, { providerId: ["gulfStatePark"] }]) {
			const h = memoryEnv();
			const response = await handleProviderScopedBeachEventRefresh(request(body), h.env, { method: "access", subject: "operator" }, vi.fn() as unknown as typeof fetch);
			expect(response.status).toBe(400);
			expect(h.values.size).toBe(0);
		}
	});

	it("requires JSON and bounds the request body", async () => {
		const h = memoryEnv();
		const wrongType = new Request("https://example.com/internal/refresh/beach-events/provider", { method: "POST", body: JSON.stringify({ providerId: "gulfStatePark" }) });
		expect((await handleProviderScopedBeachEventRefresh(wrongType, h.env, { method: "access", subject: "operator" }, vi.fn() as unknown as typeof fetch)).status).toBe(415);
		expect((await handleProviderScopedBeachEventRefresh(request({ providerId: "gulfStatePark", padding: "x".repeat(300) }), h.env, { method: "access", subject: "operator" }, vi.fn() as unknown as typeof fetch)).status).toBe(413);
		expect(h.values.size).toBe(0);
	});

	it("rejects an operationally disabled selected provider before run creation", async () => {
		const h = memoryEnv();
		const controls = defaultOperationalControl(new Date("2026-08-17T00:00:00Z"));
		controls.controls["providers.gulfStateParkEvents"] = { state: "disabled" };
		h.values.set("operational-control:v1:current", JSON.stringify(controls));
		const response = await handleProviderScopedBeachEventRefresh(request({ providerId: "gulfStatePark" }), h.env, { method: "access", subject: "operator" }, vi.fn() as unknown as typeof fetch);
		expect(response.status).toBe(409);
		expect(h.values.has(REFRESH_STATUS_KEY)).toBe(false);
	});

	it("preserves unselected provider events in the full snapshot and absence state", async () => {
		const h = memoryEnv();
		h.values.set("beach-events:v1:ical-state:gulfShoresCity", JSON.stringify({ schemaVersion: 2, validators: { etag: "other" }, lastAcceptedCompleteness: "complete" }));
		const facts: SourceFacts = { providerId: "gulfShoresCity", externalId: "existing", title: "Existing Event", venue: "Gulf Shores Public Beach", startAt: "2026-09-02T13:00:00.000Z", endAt: "2026-09-02T14:00:00.000Z", allDay: false, recurring: false, sourceName: "City of Gulf Shores", sourceURL: "https://www.gulfshoresal.gov/" };
		const existing = { ...normalizedEvent(facts, new Date("2026-08-17T12:00:00Z"))!, status: "published" as const };
		h.values.set(`${EVENT_PREFIX}${existing.id}`, JSON.stringify(existing));
		await refreshBeachEvents(h.env, new Date("2026-08-17T12:00:00Z"), vi.fn(async () => new Response(calendar(), { headers: { "Content-Type": "text/calendar" } })) as unknown as typeof fetch, { scope: { mode: "provider", providerId: "gulfStatePark" } });
		expect(JSON.parse(h.values.get(`${EVENT_PREFIX}${existing.id}`)!)).not.toHaveProperty("sourceMissingCount");
		const snapshot = JSON.parse(h.values.get(SNAPSHOT_KEY)!) as BeachEventsSnapshot;
		expect(Object.values(snapshot.beaches).flat().map((event) => event.id)).toContain(existing.id);
		expect(JSON.parse(h.values.get("beach-events:v1:ical-state:gulfShoresCity")!)).toMatchObject({ validators: { etag: "other" } });
	});

	it("conflicts with an existing all-provider run without fetching", async () => {
		const h = memoryEnv();
		h.values.set(REFRESH_STATUS_KEY, JSON.stringify({ schemaVersion: 1, runId: "existing", status: "running", trigger: "scheduled", lastAttempt: new Date().toISOString(), nextScheduledRefresh: new Date().toISOString(), scheduleDescription: "daily", operationalState: "enabled", scope: { mode: "all", requestedProviderCount: 10, attemptedProviderCount: 0 }, providers: [], counts: {} }));
		const fetcher = vi.fn();
		const response = await handleProviderScopedBeachEventRefresh(request({ providerId: "gulfStatePark" }), h.env, { method: "access", subject: "operator" }, fetcher as unknown as typeof fetch);
		expect(response.status).toBe(409);
		expect(fetcher).not.toHaveBeenCalled();
		expect(JSON.parse(h.values.get(REFRESH_STATUS_KEY)!)).toMatchObject({ runId: "existing", scope: { mode: "all" } });
	});

	it("keeps the existing all-provider behavior explicit", async () => {
		const h = memoryEnv();
		const fetcher = vi.fn(async () => new Response(calendar("shared"), { headers: { "Content-Type": "text/calendar" } }));
		const result = await refreshBeachEvents(h.env, new Date("2026-08-17T12:00:00Z"), fetcher as unknown as typeof fetch, { scope: { mode: "all" } });
		expect(fetcher).toHaveBeenCalledTimes(4);
		expect(result.refresh.scope).toMatchObject({ mode: "all", requestedProviderCount: 10, attemptedProviderCount: 4 });
	});

	it("keeps partial, rejected, and 304 outcomes local to Gulf State Park", async () => {
		const partial = memoryEnv();
		const partialResult = await refreshBeachEvents(partial.env, new Date("2026-08-17T12:00:00Z"), vi.fn(async () => new Response(mixedCalendar(49, 1), { headers: { "Content-Type": "text/calendar", ETag: "partial" } })) as unknown as typeof fetch, { scope: { mode: "provider", providerId: "gulfStatePark" } });
		expect(partialResult).toMatchObject({ outcome: "partial", refresh: { providers: [{ providerId: "gulfStatePark", status: "partial", completeness: "partial" }] }, snapshot: null });
		expect([...partial.values.keys()].filter((key) => key.includes("ical-state:"))).toEqual(["beach-events:v1:ical-state:gulfStatePark"]);

		const rejected = memoryEnv();
		const rejectedResult = await refreshBeachEvents(rejected.env, new Date("2026-08-17T12:00:00Z"), vi.fn(async () => new Response(mixedCalendar(1, 1), { headers: { "Content-Type": "text/calendar", ETag: "rejected" } })) as unknown as typeof fetch, { scope: { mode: "provider", providerId: "gulfStatePark" } });
		expect(rejectedResult).toMatchObject({ outcome: "failed", refresh: { providers: [{ providerId: "gulfStatePark", status: "failed" }] }, snapshot: null });
		expect([...rejected.values.keys()].some((key) => key.includes("ical-state:"))).toBe(false);

		const unchanged = memoryEnv();
		unchanged.values.set("beach-events:v1:ical-state:gulfStatePark", JSON.stringify({ schemaVersion: 2, validators: { etag: "same" }, lastAcceptedCompleteness: "complete", lastCompleteValidCount: 1 }));
		const unchangedResult = await refreshBeachEvents(unchanged.env, new Date("2026-08-17T12:00:00Z"), vi.fn(async () => new Response(null, { status: 304 })) as unknown as typeof fetch, { scope: { mode: "provider", providerId: "gulfStatePark" } });
		expect(unchangedResult).toMatchObject({ outcome: "completed", refresh: { providers: [{ providerId: "gulfStatePark", completeness: "confirmedUnchanged" }] } });
	});

	it("publishes valid events and records a healthy bounded quarantine without absence reconciliation", async () => {
		const h = memoryEnv();
		const result = await refreshBeachEvents(h.env, new Date("2026-08-17T12:00:00Z"), vi.fn(async () => new Response(mixedCalendar(199, 1), { headers: { "Content-Type": "text/calendar", ETag: "quarantined" } })) as unknown as typeof fetch, { scope: { mode: "provider", providerId: "gulfStatePark" } });
		expect(result).toMatchObject({ outcome: "completed", refresh: { providers: [{ providerId: "gulfStatePark", status: "ok", completeness: "quarantined", missingFromSource: 0 }] } });
		expect(result.snapshot).not.toBeNull();
		expect(JSON.parse(h.values.get("beach-events:v1:ical-state:gulfStatePark")!)).toMatchObject({ lastAcceptedCompleteness: "quarantined", lastPartialValidCount: 199 });
	});

	it("protects the route and retains the staging live-fetch gate", async () => {
		expect((await worker.fetch(request({ providerId: "gulfStatePark" }), {} as Env)).status).toBe(403);
		const h = memoryEnv(); h.env.STAGING_LIVE_PROVIDER_FETCH_ENABLED = "false";
		const response = await worker.fetch(request({ providerId: "gulfStatePark" }, { "x-refresh-secret": "test-secret" }), h.env);
		expect(response.status).toBe(503);
		expect(h.values.size).toBe(0);
	});

	it("routes an authenticated, enabled staging request through the scoped handler", async () => {
		const h = memoryEnv();
		const fetcher = vi.fn(async () => new Response(calendar(), { headers: { "Content-Type": "text/calendar" } }));
		vi.stubGlobal("fetch", fetcher);
		try {
			const response = await worker.fetch(request({ providerId: "gulfStatePark" }, { "x-refresh-secret": "test-secret" }), h.env);
			expect(response.status).toBe(200);
			expect(fetcher).toHaveBeenCalledOnce();
			expect((await response.json() as { refresh: { scope: unknown } }).refresh.scope).toMatchObject({ mode: "provider", selectedProviderId: "gulfStatePark" });
		} finally { vi.unstubAllGlobals(); }
	});
});
