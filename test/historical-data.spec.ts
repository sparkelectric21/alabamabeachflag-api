import { describe, expect, it } from "vitest";
import { extractHistoricalObservations } from "../src/history/extract";
import { appendHistoricalObservations, observationIdentity } from "../src/history/store";

class MemoryD1 {
	readonly revisions = new Set<string>();
	readonly rows: unknown[][] = [];
	prepare(sql: string) {
		return { bind: (...values: unknown[]) => ({ run: async () => {
			if (!sql.includes("historical_observations")) return { meta: { changes: 1 } };
			const key = `${values[1]}:${values[2]}`;
			if (this.revisions.has(key)) return { meta: { changes: 0 } };
			this.revisions.add(key); this.rows.push(values);
			return { meta: { changes: 1 } };
		} }) };
	}
}

describe("historical data foundation", () => {
	it("extracts selected fallback station attribution and stale state", () => {
		const records = extractHistoricalObservations("beach-conditions", {
			generatedAt: "2026-08-08T06:00:00-05:00",
			beachConditions: [{
				beachId: "fort-morgan-public-beach",
				waterTemperature: {
					temperature: 84, temperatureUnit: "F", observedAt: "2026-08-08T10:40:00Z",
					provider: "ndbc", stationId: "42357", freshnessStatus: "stale", ageMinutes: 20,
				},
			}],
		});
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			observationType: "water_temperature", beachId: "fort-morgan-public-beach",
			provider: "ndbc", stationId: "42357", freshnessState: "stale", valueNumeric: 84,
		});
	});

	it("uses an immutable logical identity but preserves meaningful revisions", async () => {
		const base = {
			observationType: "water_temperature", recordKind: "observation" as const,
			provider: "ndbc", stationId: "PPTA1", observedAt: "2026-08-08T10:00:00Z",
			fetchedAt: "2026-08-08T10:15:00Z", valueNumeric: 82, unit: "F",
		};
		const first = await observationIdentity(base);
		const repeat = await observationIdentity({ ...base, fetchedAt: "2026-08-08T10:30:00Z" });
		const revision = await observationIdentity({ ...base, valueNumeric: 83 });
		expect(repeat).toEqual(first);
		expect(revision.logicalKey).toBe(first.logicalKey);
		expect(revision.revisionHash).not.toBe(first.revisionHash);
	});

	it("suppresses changes to fetch-derived age and freshness metadata", async () => {
		const base = {
			observationType: "water_temperature", recordKind: "observation" as const,
			provider: "ndbc", stationId: "42357", observedAt: "2026-08-08T17:55:00Z",
			fetchedAt: "2026-08-08T19:30:00Z", valueNumeric: 87, unit: "F",
			freshnessState: "current", providerMetadata: { ageMinutes: 95, staleAfterMinutes: 120 },
			revisionMetadata: {},
		};
		const first = await observationIdentity(base);
		const later = await observationIdentity({
			...base,
			fetchedAt: "2026-08-08T19:45:00Z",
			freshnessState: "stale",
			providerMetadata: { ageMinutes: 110, staleAfterMinutes: 120 },
		});
		expect(later).toEqual(first);
	});

	it("creates a revision for explicitly stable source metadata changes", async () => {
		const base = {
			observationType: "tide_high", recordKind: "prediction" as const,
			provider: "noaa_coops", stationId: "8730667", observedAt: "2026-08-08T10:07:00Z",
			fetchedAt: "2026-08-08T09:00:00Z", valueNumeric: 1.151, unit: "feet",
			providerMetadata: { datum: "MLLW", curveMethod: "noaaInterval", ageMinutes: 1 },
			revisionMetadata: { datum: "MLLW", curveMethod: "noaaInterval" },
		};
		const first = await observationIdentity(base);
		const corrected = await observationIdentity({
			...base,
			providerMetadata: { datum: "MLLW", curveMethod: "fittedFromHighLow", ageMinutes: 2 },
			revisionMetadata: { datum: "MLLW", curveMethod: "fittedFromHighLow" },
		});
		expect(corrected.logicalKey).toBe(first.logicalKey);
		expect(corrected.revisionHash).not.toBe(first.revisionHash);
	});

	it("appends once, suppresses exact duplicates, and retains source corrections", async () => {
		const db = new MemoryD1();
		const record = {
			observationType: "water_temperature", recordKind: "observation" as const,
			provider: "ndbc", stationId: "PPTA1", observedAt: "2026-08-08T10:00:00Z",
			fetchedAt: "2026-08-08T10:15:00Z", valueNumeric: 82, unit: "F",
			freshnessState: "current", providerMetadata: { ageMinutes: 15 }, revisionMetadata: {},
		};
		expect(await appendHistoricalObservations(db as unknown as D1Database, "beach-conditions", [record], new Date("2026-08-08T10:15:01Z")))
			.toMatchObject({ inserted: 1, duplicates: 0 });
		expect(await appendHistoricalObservations(db as unknown as D1Database, "beach-conditions", [{
			...record, fetchedAt: "2026-08-08T10:30:00Z", freshnessState: "stale",
			providerMetadata: { ageMinutes: 30 },
		}], new Date("2026-08-08T10:30:01Z")))
			.toMatchObject({ inserted: 0, duplicates: 1 });
		expect(await appendHistoricalObservations(db as unknown as D1Database, "beach-conditions", [{ ...record, valueNumeric: 83 }]))
			.toMatchObject({ inserted: 1, duplicates: 0 });
		expect(db.rows).toHaveLength(2);
	});

	it("keeps UTC date boundaries explicit for date-only ADEM samples", () => {
		const records = extractHistoricalObservations("water-quality", {
			generatedAt: "2026-08-08T23:30:00-05:00",
			waterQuality: [{ beachId: "cotton-bayou", sampleDate: "2026-08-08", enterococcus: 41,
				advisory: false, status: "elevated", reportUrl: "https://example.test/report" }],
		});
		expect(records[0].observedAt).toBe("2026-08-08T00:00:00.000Z");
		expect(records[0].providerMetadata).toMatchObject({ timestampPrecision: "date" });
	});

	it("does not collect unavailable or malformed measurements", () => {
		const records = extractHistoricalObservations("water-quality", {
			generatedAt: "2026-08-08T12:00:00Z",
			waterQuality: [{ beachId: "x", sampleDate: null, enterococcus: Number.NaN, advisory: false }],
		});
		expect(records).toEqual([]);
	});
});
