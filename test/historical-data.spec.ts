import { describe, expect, it } from "vitest";
import { extractHistoricalObservations } from "../src/history/extract";
import { appendHistoricalObservations, observationIdentity, sourceObservationIdentity } from "../src/history/store";
import { SOURCE_CONFIGURATION_VERSION } from "../src/history/provenance";
import type { HistoricalObservationInput } from "../src/history/types";

interface Statement { sql: string; values: unknown[] }

class MemoryD1 {
	readonly revisions = new Set<string>();
	readonly rows: unknown[][] = [];
	readonly runs: Array<{ status: string; errorCode: unknown }> = [];
	failAtomicBatch = false;

	prepare(sql: string) {
		return {
			bind: (...values: unknown[]) => ({ sql, values, run: async () => {
				if (sql.includes("historical_ingestion_runs")) this.runs.push({ status: "failed", errorCode: sql.includes("atomic_batch_failed") ? "atomic_batch_failed" : null });
				return { meta: { changes: 1 }, results: [] };
			} }),
		};
	}

	async batch(statements: Statement[]) {
		if (statements.every((statement) => statement.sql.includes("SELECT 1 AS present"))) {
			return statements.map((statement) => ({ results: this.revisions.has(`${statement.values[0]}:${statement.values[1]}`) ? [{ present: 1 }] : [], meta: { changes: 0 } }));
		}
		if (this.failAtomicBatch) throw new Error("injected_atomic_failure");
		const nextRevisions = new Set(this.revisions);
		const nextRows = [...this.rows];
		for (const statement of statements) {
			if (statement.sql.includes("INSERT OR IGNORE INTO historical_observations")) {
				nextRevisions.add(`${statement.values[1]}:${statement.values[2]}`);
				nextRows.push(statement.values);
			} else if (statement.sql.includes("historical_ingestion_runs")) {
				this.runs.push({ status: "completed", errorCode: null });
			}
		}
		this.revisions.clear(); for (const key of nextRevisions) this.revisions.add(key);
		this.rows.splice(0, this.rows.length, ...nextRows);
		return statements.map(() => ({ results: [], meta: { changes: 1 } }));
	}
}

function record(overrides: Partial<HistoricalObservationInput> = {}): HistoricalObservationInput {
	return {
		observationType: "water_temperature", recordKind: "observation", beachArea: "orangeBeach",
		beachId: "alabama-point", provider: "ndbc", stationId: "PPTA1", sourceStationId: "PPTA1",
		observedAt: "2026-08-08T10:00:00Z", fetchedAt: "2026-08-08T10:15:00Z",
		valueNumeric: 82, unit: "F", observationTimeBasis: "provider_observation",
		sourceConfigurationVersion: SOURCE_CONFIGURATION_VERSION, revisionMetadata: {},
		...overrides,
	};
}

describe("historical data foundation", () => {
	it("retains area, canonical provider, station, time basis, and configuration provenance", () => {
		const [water] = extractHistoricalObservations("beach-conditions", { generatedAt: "2026-08-08T11:00:00Z", beachConditions: [{ beachId: "fort-morgan-public-beach", waterTemperature: { temperature: 84, temperatureUnit: "F", observedAt: "2026-08-08T10:40:00Z", provider: "coops", stationId: "8735180", freshnessStatus: "stale" } }] });
		expect(water).toMatchObject({ beachArea: "fortMorgan", provider: "noaa_coops", stationId: "8735180", sourceStationId: "8735180", observationTimeBasis: "provider_observation", sourceConfigurationVersion: SOURCE_CONFIGURATION_VERSION });
	});

	it("shares physical identity across beach-attributed copies", async () => {
		const first = record({ beachId: "alabama-point" });
		const second = record({ beachId: "cotton-bayou" });
		expect((await observationIdentity(first)).logicalKey).not.toBe((await observationIdentity(second)).logicalKey);
		expect(await sourceObservationIdentity(first)).toBe(await sourceObservationIdentity(second));
	});

	it("preserves meaningful revisions but ignores fetch-derived state", async () => {
		const base = record({ freshnessState: "current", providerMetadata: { ageMinutes: 15 } });
		const repeat = record({ fetchedAt: "2026-08-08T10:30:00Z", freshnessState: "stale", providerMetadata: { ageMinutes: 30 } });
		const revision = record({ valueNumeric: 83 });
		expect(await observationIdentity(repeat)).toEqual(await observationIdentity(base));
		expect((await observationIdentity(revision)).logicalKey).toBe((await observationIdentity(base)).logicalKey);
		expect((await observationIdentity(revision)).revisionHash).not.toBe((await observationIdentity(base)).revisionHash);
	});

	it("atomically appends, suppresses duplicates, and retains corrections", async () => {
		const db = new MemoryD1();
		expect(await appendHistoricalObservations(db as unknown as D1Database, "beach-conditions", [record()])).toMatchObject({ inserted: 1, duplicates: 0 });
		expect(await appendHistoricalObservations(db as unknown as D1Database, "beach-conditions", [record({ fetchedAt: "2026-08-08T10:30:00Z" })])).toMatchObject({ inserted: 0, duplicates: 1 });
		expect(await appendHistoricalObservations(db as unknown as D1Database, "beach-conditions", [record({ valueNumeric: 83 })])).toMatchObject({ inserted: 1, duplicates: 0 });
		expect(db.rows).toHaveLength(2);
	});

	it("rolls back an atomic batch and persists a visible failed run", async () => {
		const db = new MemoryD1(); db.failAtomicBatch = true;
		await expect(appendHistoricalObservations(db as unknown as D1Database, "beach-conditions", [record()])).rejects.toThrow("injected_atomic_failure");
		expect(db.rows).toHaveLength(0);
		expect(db.runs).toContainEqual({ status: "failed", errorCode: "atomic_batch_failed" });
	});

	it("retains ADEM site identity and date-only semantics", () => {
		const [result] = extractHistoricalObservations("water-quality", { generatedAt: "2026-08-08T23:30:00Z", waterQuality: [{ beachId: "cotton-bayou", sampleDate: "2026-08-08", enterococcus: 41, advisory: false, status: "elevated", reportUrl: "https://example.test/report" }] });
		expect(result).toMatchObject({ observedAt: "2026-08-08T00:00:00.000Z", beachArea: "orangeBeach", stationId: "COT_BYOU", sourceStationId: "COT_BYOU", observationTimeBasis: "sample_date" });
		expect(result.providerMetadata).toMatchObject({ timestampPrecision: "date" });
	});

	it("labels flag time as an inferred hourly snapshot", () => {
		const [flag] = extractHistoricalObservations("beach-flags", { generatedAt: "2026-08-08T21:56:00Z", beachFlags: [{ beachId: "gulf-shores-public-beach", lastUpdated: "2026-08-08T21:56:00Z", primaryFlag: "yellow", hasPurpleFlag: false, sourceType: "official", sourceName: "City of Gulf Shores" }] });
		expect(flag).toMatchObject({ provider: "city_gulf_shores", beachArea: "gulfShores", observedAt: "2026-08-08T21:00:00.000Z", observationTimeBasis: "inferred_snapshot" });
		expect(flag.providerMetadata).toMatchObject({ timestampPrecision: "hour", observationTimeBasis: "inferred_snapshot" });
	});

	it("does not collect unavailable or malformed measurements", () => {
		expect(extractHistoricalObservations("water-quality", { generatedAt: "2026-08-08T12:00:00Z", waterQuality: [{ beachId: "x", sampleDate: null, enterococcus: Number.NaN, advisory: false }] })).toEqual([]);
	});
});
