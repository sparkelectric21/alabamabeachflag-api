import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleProviderHealthAdminRequest } from "../src/routes/providerHealthAdmin";
import type { Env } from "../src/types";

function harness(records: Record<string, unknown>) {
	const get = vi.fn(async (key: string) => key in records ? structuredClone(records[key]) : null);
	const list = vi.fn(async ({ prefix }: { prefix: string }) => ({ keys: Object.keys(records).filter((name) => name.startsWith(prefix)).map((name) => ({ name })) }));
	const put = vi.fn(async (key: string, value: string) => { records[key] = JSON.parse(value); });
	return { env: { BEACH_DATA: { get, list, put }, REFRESH_SECRET: "secret", ALLOW_LEGACY_REFRESH_SECRET: "true" } as unknown as Env, put };
}

const healthy = { provider: "nws", domain: "hourly_forecast", currentStatus: "healthy", consecutiveFailures: 0, consecutiveSuccesses: 4, affectedBeachCount: 0, expectedBeachCount: 9, lastSuccessAt: "2026-07-21T18:00:00Z", alertState: "clear", updatedAt: "2026-07-21T18:00:00Z" };
const incident = { ...healthy, currentStatus: "unavailable", consecutiveFailures: 2, consecutiveSuccesses: 0, affectedBeachCount: 9, firstFailureAt: "2026-07-21T17:45:00Z", lastFailureAt: "2026-07-21T18:00:00Z", lastErrorReason: "token=private https://upstream.test/raw?key=secret", activeIncidentId: "nws:forecast:1", incidentKind: "shared_provider", alertState: "active", alertOpenedAt: "2026-07-21T18:00:00Z" };

describe("provider-health admin endpoint", () => {
	it("rejects unauthenticated requests and allows authenticated read-only access", async () => {
		const h = harness({ "provider-health:v1:states": { version: 1, states: [healthy] } });
		expect((await worker.fetch(new Request("https://example.com/admin/provider-health"), h.env)).status).toBe(403);
		const response = await worker.fetch(new Request("https://example.com/admin/provider-health", { headers: { "x-refresh-secret": "secret" } }), h.env);
		expect(response.status).toBe(200);
		expect((await response.json() as any)).toMatchObject({ schemaVersion: 2, overall: { status: "healthy", expectedBeachCount: 9 }, catalogSummary: { primaryProviderCount: 5, standbyProviderCount: 3 }, providerCatalog: expect.arrayContaining([expect.objectContaining({ provider: "nws", role: "Primary", health: expect.objectContaining({ status: "healthy" }) })]), providers: [expect.objectContaining({ provider: "nws", status: "healthy" })] });
		expect((await worker.fetch(new Request("https://example.com/admin/provider-health", { method: "POST", headers: { "x-refresh-secret": "secret" } }), h.env)).status).toBe(405);
	});

	it("calculates degraded and critical summaries, skips malformed data, and redacts diagnostics", async () => {
		const regional = { ...healthy, provider: "open_meteo", domain: "current_uv:dauphinIsland", expectedBeachCount: 2 };
		const h = harness({ "provider-health:v1:states": { version: 1, states: [healthy, { malformed: true }, incident, regional] }, "provider-health:v1:event:bad": { malformed: true } });
		const response = await handleProviderHealthAdminRequest(h.env);
		const body = await response.json() as any;
		expect(body).toMatchObject({ status: "ok", schemaVersion: 2, overall: { status: "degraded", activeIncidentCount: 1, degradedProviderCount: 1 }, providers: [{ status: "healthy" }, { status: "incident" }, { provider: "open_meteo", domain: "current_uv:dauphinIsland" }] });
		expect(JSON.stringify(body)).not.toContain("private");
		expect(JSON.stringify(body)).not.toContain("upstream.test");
		const critical = harness({ "provider-health:v1:states": { states: [{ ...incident, provider: "publication_quality_gate", domain: "beach_conditions", incidentKind: "quality_gate" }] } });
		expect((await (await handleProviderHealthAdminRequest(critical.env)).json() as any).overall.status).toBe("critical");
	});

	it("persists only editable metadata and records sanitized audit entries", async () => {
		const h = harness({});
		const request = new Request("https://example.com/admin/provider-catalog", { method: "PATCH", headers: { "content-type": "application/json", "x-refresh-secret": "secret" }, body: JSON.stringify({ provider: "open_meteo", domain: "current_uv:orangeBeach", changes: { role: "Automatic Fallback", description: "Documented fallback.", usedFor: ["Monitoring"], productionUsage: "Standby.", internalNotes: "Admin only.", category: "Changed" } }) });
		const response = await worker.fetch(request, h.env);
		expect(response.status).toBe(200);
		const body = await response.json() as any;
		expect(body.record).toMatchObject({ role: "Automatic Fallback", category: "UV", internalNotes: "Admin only." });
		expect(body.audit.map((entry: any) => entry.field)).toEqual(expect.arrayContaining(["role", "description", "usedFor", "productionUsage", "internalNotes"]));
		expect(body.audit).toHaveLength(5);
		expect(h.put).toHaveBeenCalledTimes(6);
		expect(JSON.stringify(h.put.mock.calls)).not.toContain("x-refresh-secret");
	});

	it("rejects unauthenticated and invalid catalog mutations and ignores malformed overrides", async () => {
		const h = harness({ "provider-catalog:v1:nws:hourly_forecast": { role: "Runtime Router", internalNotes: 42 } });
		expect((await worker.fetch(new Request("https://example.com/admin/provider-catalog", { method: "PATCH", body: "{}" }), h.env)).status).toBe(403);
		const invalid = new Request("https://example.com/admin/provider-catalog", { method: "PATCH", headers: { "content-type": "application/json", "x-refresh-secret": "secret" }, body: JSON.stringify({ provider: "nws", domain: "hourly_forecast", changes: { role: "Runtime Router" } }) });
		expect((await worker.fetch(invalid, h.env)).status).toBe(400);
		const body = await (await handleProviderHealthAdminRequest(h.env)).json() as any;
		expect(body.providerCatalog.find((item: any) => item.provider === "nws")).toMatchObject({ role: "Primary", internalNotes: "" });
	});
});
