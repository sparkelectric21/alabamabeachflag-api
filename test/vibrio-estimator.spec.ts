import { describe, expect, it } from "vitest";
import {
	estimateVibrioConditions,
	estimateVibrioEnvironmentalConditions,
} from "../src/services/vibrio/estimator";
import { validVibrioObservation as observation, vibrioEstimatorFixtures, vibrioFixtureNow as now } from "./fixtures/vibrioConditions";

describe("VibrioConditionsEstimator", () => {
	it("is unavailable when feature-disabled", () => expect(estimateVibrioConditions({ enabled: false, now, observation }).status).toBe("unavailable"));
	it.each([5, 6, 7, 8, 9, 10])("returns seasonal awareness throughout month %s", (month) => {
		const result = estimateVibrioConditions({
			enabled: true,
			now: new Date(`2026-${String(month).padStart(2, "0")}-15T12:00:00.000Z`),
		});
		expect(result.status).toBe("seasonalAwareness");
	});
	it.each([1, 2, 3, 4, 11, 12])("is unavailable outside the season in month %s", (month) => {
		const result = estimateVibrioConditions({
			enabled: true,
			now: new Date(`2026-${String(month).padStart(2, "0")}-15T12:00:00.000Z`),
		});
		expect(result.status).toBe("unavailable");
	});
	it("is unavailable off-season", () => expect(estimateVibrioConditions({ enabled: true, now: new Date("2026-11-01T12:00:00Z"), observation }).status).toBe("unavailable"));
	it("shows awareness when temperature is missing", () => {
		const result = estimateVibrioConditions({ enabled: true, now });
		expect(result).toMatchObject({ status: "seasonalAwareness", source: { name: "CDC", kind: "education" } });
		expect(result).not.toHaveProperty("waterTemperature");
	});
	it.each([
		["stale", { ...observation, observedAt: "2026-07-17T15:00:00Z" }],
		["future-dated", { ...observation, observedAt: "2026-07-17T19:00:00Z" }],
		["missing-provider", { ...observation, provider: "unknown" }],
	] as const)("keeps awareness visible with a %s supplemental observation", (_name, candidate) => {
		const result = estimateVibrioConditions({ enabled: true, now, observation: candidate as never });
		expect(result.status).toBe("seasonalAwareness");
	});
	it("includes a valid supplemental temperature without making it an eligibility input", () => {
		const result = estimateVibrioConditions({ enabled: true, now, observation });
		expect(result).toMatchObject({
			status: "seasonalAwareness",
			waterTemperature: { value: 86, unit: "F" },
			dataTimestamp: observation.observedAt,
		});
	});
});

describe("disabled future Vibrio environmental model", () => {
	it.each([
		["missing observation", vibrioEstimatorFixtures.unavailable, "missing_observation"],
		["missing temperature", vibrioEstimatorFixtures.missingTemperature, "missing_temperature"],
		["stale observation", vibrioEstimatorFixtures.staleObservation, "stale_observation"],
		["future observation", vibrioEstimatorFixtures.futureObservation, "future_observation"],
		["invalid temperature", vibrioEstimatorFixtures.invalidTemperature, "invalid_temperature"],
		["malformed timestamp", vibrioEstimatorFixtures.malformedTimestamp, "parser_failure"],
	] as const)("returns a deterministic diagnostic for %s", (_name, candidate, diagnosticCode) => {
		const result = estimateVibrioEnvironmentalConditions({ enabled: true, now, observation: candidate as never });
		expect(result.status).toBe("unavailable");
		expect(result.diagnosticCode).toBe(diagnosticCode);
	});
	it("fails closed on an unknown prototype provider", () => {
		const result = estimateVibrioEnvironmentalConditions({ enabled: true, now, observation: vibrioEstimatorFixtures.unknownProvider as never });
		expect(result.status).toBe("unavailable");
		expect(result.diagnosticCode).toBe("parser_failure");
	});
});
