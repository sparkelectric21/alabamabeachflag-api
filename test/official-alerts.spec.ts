import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { normalizeNwsFeature } from "../src/officialAlerts/nwsAdapter";
import { compareOfficialAlerts } from "../src/officialAlerts/order";
import { NWS_EVENT_POLICY, policyFor } from "../src/officialAlerts/policy";
import { refreshOfficialAlerts } from "../src/officialAlerts/refresh";
import { ABF_ALERT_REGIONS, ABF_ALERT_REGION_VERSION } from "../src/officialAlerts/regions";
import { compareLegacyPolicy } from "../src/officialAlerts/shadow";
import type { Env } from "../src/types";

const now = new Date("2026-08-17T18:00:00.000Z");

function feature(event: string, overrides: Record<string, unknown> = {}) {
	return {
		id: `https://api.weather.gov/alerts/${encodeURIComponent(event)}`,
		geometry: { type: "Polygon", coordinates: [[[-87.7,30.2],[-87.6,30.2],[-87.6,30.3],[-87.7,30.3],[-87.7,30.2]]] },
		properties: {
			event, sender: "w-nws.webmaster@noaa.gov", senderName: "NWS Mobile/Pensacola",
			severity: "Severe", urgency: "Immediate", certainty: "Likely", status: "Actual", messageType: "Alert",
			headline: `${event} issued`, description: "Official description", instruction: "Follow official instructions.",
			sent: "2026-08-17T17:55:00Z", effective: "2026-08-17T17:55:00Z", onset: "2026-08-17T18:00:00Z", expires: "2026-08-17T20:00:00Z",
			web: "https://alerts.weather.gov/example", eventCode: { SAME: ["SVR"] }, ...overrides,
		},
	};
}

function kvHarness(initial?: Record<string, unknown>) {
	const records = new Map<string, string>(Object.entries(initial ?? {}).map(([key, value]) => [key, JSON.stringify(value)]));
	return {
		records,
		env: { BEACH_DATA: {
			get: vi.fn(async (key: string, type?: string) => { const value = records.get(key); return value === undefined ? null : type === "json" ? JSON.parse(value) : value; }),
			put: vi.fn(async (key: string, value: string) => { records.set(key, value); }),
		} } as unknown as Env,
	};
}

afterEach(() => vi.unstubAllGlobals());

describe("explicit NWS event policy", () => {
	it.each(Object.entries(NWS_EVENT_POLICY))("supports %s as %s", (event, expected) => {
		expect(policyFor(event)).toEqual(expected);
	});
	it.each(["Flood Warning", "River Flood Warning", "Air Quality Alert", "Dense Fog Advisory", "Civil Emergency Message"])("explicitly excludes %s", (event) => {
		expect(policyFor(event)).toBeNull();
	});
	it("classifies Special Marine Warning as marine weather", () => expect(policyFor("Special Marine Warning")?.category).toBe("marineWeather"));
});

describe("normalization and stable identity", () => {
	it("uses the same stable ID for repeated source data and merges no natural-language locality", async () => {
		const first = await normalizeNwsFeature(feature("Tornado Warning"), "gulfShores", now.toISOString());
		const second = await normalizeNwsFeature(feature("Tornado Warning"), "orangeBeach", new Date(now.getTime() + 60_000).toISOString());
		expect(first?.id).toBe(second?.id);
		expect(first).toMatchObject({ event: "Tornado Warning", affectedRegions: ["gulfShores"], lifecycleState: "active" });
	});
	it("rejects malformed required dates, unknown enums remain Unknown, and ignores unknown events", async () => {
		expect(await normalizeNwsFeature(feature("Tornado Warning", { expires: "bad" }), "gulfShores", now.toISOString())).toBeNull();
		expect(await normalizeNwsFeature(feature("Air Quality Alert"), "gulfShores", now.toISOString())).toBeNull();
		expect(await normalizeNwsFeature(feature("Tornado Warning", { severity: "Catastrophic" }), "gulfShores", now.toISOString())).toMatchObject({ severity: "Unknown" });
	});
});

describe("versioned structured geography", () => {
	it("defines four distinct conservative WGS84 polygons and query points", () => {
		expect(ABF_ALERT_REGION_VERSION).toMatch(/\.v1$/);
		expect(ABF_ALERT_REGIONS.map((region) => region.id)).toEqual(["gulfShores", "orangeBeach", "fortMorgan", "dauphinIsland"]);
		for (const region of ABF_ALERT_REGIONS) expect(region.polygon.coordinates[0][0]).toEqual(region.polygon.coordinates[0].at(-1));
	});
});

describe("ingestion, lifecycle, outage behavior, and ordering", () => {
	it("keeps multiple alerts, combines region membership, expires old data, and sorts deterministically", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			const point = new URL(input.toString()).searchParams.get("point");
			const features = point?.startsWith("30.250144") ? [feature("Special Marine Warning")] : [feature("Tornado Warning"), feature("High Surf Advisory")];
			return Response.json({ type: "FeatureCollection", features }, { headers: { "Content-Type": "application/geo+json", ETag: '"v1"' } });
		}));
		const h = kvHarness();
		const snapshot = await refreshOfficialAlerts(h.env, now);
		expect(snapshot.sourceFreshness).toBe("fresh");
		expect(snapshot.alerts.map((alert) => alert.event)).toEqual(["Tornado Warning", "Special Marine Warning", "High Surf Advisory"]);
		expect(snapshot.alerts.find((alert) => alert.event === "Tornado Warning")?.affectedRegions).toEqual(["fortMorgan", "gulfShores", "orangeBeach"]);
		const later = new Date("2026-08-17T21:00:00Z");
		const expired = await refreshOfficialAlerts(h.env, later);
		expect(expired.alerts).toEqual([]);
		expect(expired.history.some((alert) => alert.lifecycleState === "expired")).toBe(true);
	});

	it("retains only unexpired last-known data on total source failure and reports unavailable after the cutoff", async () => {
		const h = kvHarness();
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ features: [feature("Tornado Warning", { expires: "2026-08-17T23:00:00Z" })] }, { headers: { "Content-Type": "application/geo+json" } })));
		await refreshOfficialAlerts(h.env, now);
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
		const stale = await refreshOfficialAlerts(h.env, new Date("2026-08-17T18:30:00Z"));
		expect(stale.sourceFreshness).toBe("stale");
		expect(stale.alerts).toHaveLength(1);
		const unavailable = await refreshOfficialAlerts(h.env, new Date("2026-08-17T19:01:00Z"));
		expect(unavailable.sourceFreshness).toBe("unavailable");
		expect(unavailable.alerts).toHaveLength(1);
	});

	it("does not let a malformed known alert poison the last-known active set", async () => {
		const h = kvHarness();
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ features: [feature("Tornado Warning")] }, { headers: { "Content-Type": "application/geo+json" } })));
		await refreshOfficialAlerts(h.env, now);
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ features: [feature("Tornado Warning", { expires: "not-a-date" })] }, { headers: { "Content-Type": "application/geo+json" } })));
		const result = await refreshOfficialAlerts(h.env, new Date("2026-08-17T18:05:00Z"));
		expect(result.alerts).toHaveLength(1);
		expect(Object.values(result.regions).every((region) => region.status === "failed" && region.parseFailures === 1)).toBe(true);
	});

	it("has a stable final tie-break", async () => {
		const a = await normalizeNwsFeature(feature("Tornado Warning"), "gulfShores", now.toISOString());
		const b = await normalizeNwsFeature({ ...feature("Tornado Warning"), id: "https://api.weather.gov/alerts/other" }, "gulfShores", now.toISOString());
		expect([a!, b!].sort(compareOfficialAlerts).map((alert) => alert.id)).toEqual([a!.id, b!.id].sort());
	});
});

describe("public API and source health", () => {
	it("returns a sanitized multi-alert contract, supports region filtering, rejects invalid regions, and never serves expired alerts", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.json({ features: [feature("Tornado Warning"), feature("High Surf Advisory", { expires: "2026-08-17T17:00:00Z" })] }, { headers: { "Content-Type": "application/geo+json" } })));
		const h = kvHarness();
		await refreshOfficialAlerts(h.env, now);
		const response = await worker.fetch(new Request("https://example.com/v1/official-alerts?region=gulfShores"), h.env);
		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body).toMatchObject({ schemaVersion: 1, sourceFreshness: "fresh", alerts: [{ event: "Tornado Warning", source: "nws", affectedRegions: expect.arrayContaining(["gulfShores"]) }] });
		expect(body.alerts[0].sourceIdentifier).toBeUndefined();
		expect((await worker.fetch(new Request("https://example.com/v1/official-alerts?region=invalid"), h.env)).status).toBe(400);
		const health = await worker.fetch(new Request("https://example.com/admin/official-alerts/health", { headers: { "x-refresh-secret": "secret" } }), { ...h.env, REFRESH_SECRET: "secret", ALLOW_LEGACY_REFRESH_SECRET: "true" } as Env);
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ source: "nws", freshness: "fresh", activeAlertCount: 1, regions: expect.any(Array) });
	});

	it("returns an honest unavailable response before first ingestion", async () => {
		const response = await worker.fetch(new Request("https://example.com/v1/official-alerts"), kvHarness().env);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ sourceFreshness: "unavailable", alerts: [] });
	});
});

describe("shadow comparison", () => {
	it("documents policy, locality, and category differences without producing alerts", () => {
		expect(compareLegacyPolicy("Extreme Wind Warning")).toMatchObject({ legacyIncluded: false, backendIncluded: true, difference: "backend_only_explicit_policy" });
		expect(compareLegacyPolicy("Marine Dense Fog Statement")).toMatchObject({ legacyIncluded: true, backendIncluded: false, difference: "legacy_only_broad_substring" });
		expect(compareLegacyPolicy("Special Marine Warning")).toMatchObject({ legacyIncluded: true, backendIncluded: true, difference: null });
	});
});
