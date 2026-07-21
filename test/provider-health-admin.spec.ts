import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { handleProviderHealthAdminRequest } from "../src/routes/providerHealthAdmin";
import type { Env } from "../src/types";

function harness(records: Record<string, unknown>) {
	const get = vi.fn(async (key: string) => key in records ? structuredClone(records[key]) : null);
	const list = vi.fn(async ({ prefix }: { prefix: string }) => ({ keys: Object.keys(records).filter((name) => name.startsWith(prefix)).map((name) => ({ name })) }));
	return { env: { BEACH_DATA: { get, list }, REFRESH_SECRET: "secret", ALLOW_LEGACY_REFRESH_SECRET: "true" } as unknown as Env };
}

const healthy = { provider: "nws", domain: "forecast", currentStatus: "healthy", consecutiveFailures: 0, consecutiveSuccesses: 4, affectedBeachCount: 0, expectedBeachCount: 9, lastSuccessAt: "2026-07-21T18:00:00Z", alertState: "clear", updatedAt: "2026-07-21T18:00:00Z" };
const incident = { ...healthy, currentStatus: "unavailable", consecutiveFailures: 2, consecutiveSuccesses: 0, affectedBeachCount: 9, firstFailureAt: "2026-07-21T17:45:00Z", lastFailureAt: "2026-07-21T18:00:00Z", lastErrorReason: "token=private https://upstream.test/raw?key=secret", activeIncidentId: "nws:forecast:1", incidentKind: "shared_provider", alertState: "active", alertOpenedAt: "2026-07-21T18:00:00Z" };

describe("provider-health admin endpoint", () => {
	it("rejects unauthenticated requests and allows authenticated read-only access", async () => {
		const h = harness({ "provider-health:v1:states": { version: 1, states: [healthy] } });
		expect((await worker.fetch(new Request("https://example.com/admin/provider-health"), h.env)).status).toBe(403);
		const response = await worker.fetch(new Request("https://example.com/admin/provider-health", { headers: { "x-refresh-secret": "secret" } }), h.env);
		expect(response.status).toBe(200);
		expect((await response.json() as { overall: unknown; providers: unknown[] })).toMatchObject({ overall: { status: "healthy", expectedBeachCount: 9 }, providers: [expect.objectContaining({ provider: "nws", status: "healthy" })] });
		expect((await worker.fetch(new Request("https://example.com/admin/provider-health", { method: "POST", headers: { "x-refresh-secret": "secret" } }), h.env)).status).toBe(405);
	});

	it("calculates degraded and critical summaries, skips malformed data, and redacts diagnostics", async () => {
		const regional = { ...healthy, provider: "open_meteo", domain: "current_uv:dauphinIsland", expectedBeachCount: 2 };
		const h = harness({ "provider-health:v1:states": { version: 1, states: [healthy, { malformed: true }, incident, regional] }, "provider-health:v1:event:bad": { malformed: true } });
		const response = await handleProviderHealthAdminRequest(h.env);
		const body = await response.json() as any;
		expect(body).toMatchObject({ status: "ok", schemaVersion: 1, overall: { status: "degraded", activeIncidentCount: 1, degradedProviderCount: 1 }, providers: [{ status: "healthy" }, { status: "incident" }, { provider: "open_meteo", domain: "current_uv:dauphinIsland" }] });
		expect(JSON.stringify(body)).not.toContain("private");
		expect(JSON.stringify(body)).not.toContain("upstream.test");
		const critical = harness({ "provider-health:v1:states": { states: [{ ...incident, provider: "publication_quality_gate", domain: "beach_conditions", incidentKind: "quality_gate" }] } });
		expect((await (await handleProviderHealthAdminRequest(critical.env)).json() as any).overall.status).toBe("critical");
	});
});
