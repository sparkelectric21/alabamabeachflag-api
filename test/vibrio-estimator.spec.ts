import { describe, expect, it } from "vitest";
import { estimateVibrioConditions } from "../src/services/vibrio/estimator";
import { validVibrioObservation as observation, vibrioEstimatorFixtures, vibrioFixtureNow as now } from "./fixtures/vibrioConditions";

describe("VibrioConditionsEstimator", () => {
	it("is unavailable when feature-disabled", () => expect(estimateVibrioConditions({ enabled: false, now, observation }).status).toBe("unavailable"));
	it("returns educational seasonal awareness in May through October", () => expect(estimateVibrioConditions({ enabled: true, now, observation }).status).toBe("seasonalAwareness"));
	it("is unavailable off-season", () => expect(estimateVibrioConditions({ enabled: true, now: new Date("2026-11-01T12:00:00Z"), observation }).status).toBe("unavailable"));
	it("is unavailable with missing data", () => expect(estimateVibrioConditions({ enabled: true, now }).status).toBe("unavailable"));
	it("rejects stale data", () => expect(estimateVibrioConditions({ enabled: true, now, observation: { ...observation, observedAt: "2026-07-17T15:00:00Z" } }).status).toBe("unavailable"));
	it("rejects future-dated data", () => expect(estimateVibrioConditions({ enabled: true, now, observation: { ...observation, observedAt: "2026-07-17T19:00:00Z" } }).status).toBe("unavailable"));
	it.each([NaN, 27, 105])("rejects invalid temperature %s", (waterTemperature) => expect(estimateVibrioConditions({ enabled: true, now, observation: { ...observation, waterTemperature } }).status).toBe("unavailable"));
	it("rejects invalid salinity", () => expect(estimateVibrioConditions({ enabled: true, now, observation: { ...observation, salinity: 46, salinityUnit: "psu" } }).status).toBe("unavailable"));
	it.each([
		["missing observation", vibrioEstimatorFixtures.unavailable, "missing_observation"],
		["missing temperature", vibrioEstimatorFixtures.missingTemperature, "invalid_temperature"],
		["stale observation", vibrioEstimatorFixtures.staleObservation, "stale_observation"],
		["future observation", vibrioEstimatorFixtures.futureObservation, "future_observation"],
		["invalid temperature", vibrioEstimatorFixtures.invalidTemperature, "invalid_temperature"],
		["malformed timestamp", vibrioEstimatorFixtures.malformedTimestamp, "parser_failure"],
	] as const)("returns a deterministic diagnostic for %s", (_name, candidate, diagnosticCode) => {
		const result = estimateVibrioConditions({ enabled: true, now, observation: candidate as never });
		expect(result.status).toBe("unavailable");
		expect(result.diagnosticCode).toBe(diagnosticCode);
	});
	it("fails closed on an unknown prototype provider", () => {
		const result = estimateVibrioConditions({ enabled: true, now, observation: vibrioEstimatorFixtures.unknownProvider as never });
		expect(result.status).toBe("unavailable");
		expect(result.diagnosticCode).toBe("parser_failure");
	});
});
