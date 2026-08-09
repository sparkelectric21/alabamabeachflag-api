import { describe, expect, it } from "vitest";
import { handleHistoricalObservations } from "../src/history/observations";
import type { Env } from "../src/types";

function envWith(rows: Array<Record<string, unknown>> = []) {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const db = { prepare(sql: string) { return { bind(...values: unknown[]) { calls.push({ sql, values }); return { all: async () => ({ results: rows, success: true, meta: {} }) }; } }; } } as unknown as D1Database;
	return { env: { HISTORICAL_DATA: db } as Env, calls };
}
const request = (query = "") => new Request(`https://example.test/admin/historical-data/observations${query}`);

describe("historical observation browser", () => {
	it("returns an explicit unconfigured response with no-store", async () => { const response = await handleHistoricalObservations(request(), {} as Env); expect(response.status).toBe(503); expect(response.headers.get("Cache-Control")).toBe("no-store"); });
	it("uses bounded deterministic current-revision pagination", async () => { const rows = Array.from({ length: 11 }, (_, i) => ({ id: `id-${20-i}`, stored_at: `2026-08-08T10:${20-i}:00Z`, provider_metadata: "{}" })); const {env,calls}=envWith(rows); const response=await handleHistoricalObservations(request("?pageSize=10"),env); const body=await response.json() as any; expect(body.rows).toHaveLength(10); expect(body.hasMore).toBe(true); expect(body.nextCursor).toBeTruthy(); expect(calls[0].sql).toContain("ORDER BY o.stored_at DESC, o.id DESC LIMIT ?"); expect(calls[0].sql).toContain("NOT EXISTS"); expect(calls[0].values.at(-1)).toBe(11); });
	it("allowlists parameters and page sizes", async () => { const {env}=envWith(); expect((await handleHistoricalObservations(request("?sort=drop"),env)).status).toBe(400); expect((await handleHistoricalObservations(request("?pageSize=1000"),env)).status).toBe(400); expect((await handleHistoricalObservations(request("?area=elsewhere"),env)).status).toBe(400); expect((await handleHistoricalObservations(request("?observedFrom=nope"),env)).status).toBe(400); });
	it("binds combined filters and supports all revisions", async () => { const {env,calls}=envWith(); const response=await handleHistoricalObservations(request("?type=water_temperature&area=orangeBeach&beach=alabama-point&provider=noaa_coops&station=8735180&freshness=stale&quality=reviewed&observedFrom=2026-08-01T00%3A00%3A00Z&storedTo=2026-08-09T00%3A00%3A00Z&revisions=all&pageSize=25"),env); expect(response.status).toBe(200); expect(calls[0].sql).not.toContain("NOT EXISTS"); expect(calls[0].values).toContain("orangeBeach"); expect(calls[0].values).toContain("8735180"); });
	it("applies a stable cursor boundary", async () => { const {env}=envWith([{id:"b",stored_at:"2026-08-08T10:00:00Z"},{id:"a",stored_at:"2026-08-08T10:00:00Z"}]); const first=await handleHistoricalObservations(request("?pageSize=10"),env); expect(first.status).toBe(200); const invalid=await handleHistoricalObservations(request("?cursor=invalid"),env); expect(invalid.status).toBe(400); });
});
