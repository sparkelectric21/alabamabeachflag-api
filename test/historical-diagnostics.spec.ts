import { describe, expect, it } from "vitest";
import { handleHistoricalDiagnostics, HISTORICAL_JOB_HEALTH } from "../src/history/diagnostics";
import type { Env } from "../src/types";

function database(results: unknown[][]): D1Database {
	let next = 0;
	return {
		prepare: () => ({}) as D1PreparedStatement,
		batch: async () => results.map((rows) => ({ results: rows, success: true, meta: {} })),
	} as unknown as D1Database;
}

describe("historical diagnostics", () => {
	it("returns explicit environment and configuration status without D1", async () => {
		const response = await handleHistoricalDiagnostics({ HISTORICAL_DATA_ENVIRONMENT: "production" } as Env);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "not_configured", configured: false, environment: "production" });
	});

	it("summarizes beach rows, physical observations, revisions, job health, and deterministic latest rows", async () => {
		const now = new Date("2026-08-09T01:00:00Z");
		const summary = { beach_attributed_rows: 12, logical_observations: 10, unique_physical_source_observations: 4, revision_count: 2 };
		const jobs = [
			{ job: "beach-flags", last_attempt_at: "2026-08-09T00:55:00Z", last_success_at: "2026-08-09T00:55:00Z" },
			{ job: "beach-conditions", last_attempt_at: "2026-08-09T00:45:00Z", last_success_at: "2026-08-09T00:45:00Z" },
			{ job: "water-quality", last_attempt_at: "2026-08-08T20:00:00Z", last_success_at: "2026-08-08T20:00:00Z" },
		];
		const latest = [{ provider: "noaa_coops", source_station_id: "8735180", observation_type: "water_temperature", beach_id: "alabama-point" }, { provider: "noaa_coops", source_station_id: "8735180", observation_type: "water_temperature", beach_id: "dauphin-island-public-beach" }];
		const response = await handleHistoricalDiagnostics({ HISTORICAL_DATA: database([[summary], jobs, [], [], [], latest]), HISTORICAL_DATA_ENVIRONMENT: "production" } as Env, now);
		const body = await response.json() as any;
		expect(body.status).toBe("ok");
		expect(body.summary).toMatchObject(summary);
		expect(body.jobHealth.map((item: any) => item.status)).toEqual(["healthy", "healthy", "healthy"]);
		expect(body.latestByBeachSource).toHaveLength(2);
		expect(body.lastIngestionRun.job).toBe("beach-flags");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("uses explicit, testable missed-ingestion tolerances", async () => {
		expect(HISTORICAL_JOB_HEALTH).toEqual({
			"beach-flags": { cadenceMinutes: 5, maximumSuccessAgeMinutes: 15 },
			"beach-conditions": { cadenceMinutes: 15, maximumSuccessAgeMinutes: 45 },
			"water-quality": { cadenceMinutes: 360, maximumSuccessAgeMinutes: 840 },
		});
		const response = await handleHistoricalDiagnostics({ HISTORICAL_DATA: database([[{}], [], [], [], [], []]), HISTORICAL_DATA_ENVIRONMENT: "production" } as Env, new Date("2026-08-09T01:00:00Z"));
		expect((await response.json() as any).jobHealth.every((item: any) => item.status === "never_succeeded")).toBe(true);
	});
});
