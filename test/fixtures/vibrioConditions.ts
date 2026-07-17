import type { VibrioConditionsObservation } from "../../src/services/vibrio/estimator";

export const vibrioFixtureNow = new Date("2026-07-17T18:00:00.000Z");
export const validVibrioObservation: VibrioConditionsObservation = {
	waterTemperature: 86,
	waterTemperatureUnit: "F",
	observedAt: "2026-07-17T17:00:00.000Z",
	provider: "fixture",
	stationId: "QA-FIXTURE",
};

export const vibrioEstimatorFixtures = {
	seasonalAwareness: validVibrioObservation,
	unavailable: null,
	missingTemperature: { ...validVibrioObservation, waterTemperature: undefined },
	staleObservation: { ...validVibrioObservation, observedAt: "2026-07-17T15:00:00.000Z" },
	futureObservation: { ...validVibrioObservation, observedAt: "2026-07-17T19:00:00.000Z" },
	invalidTemperature: { ...validVibrioObservation, waterTemperature: 212 },
	malformedTimestamp: { ...validVibrioObservation, observedAt: "not-a-date" },
	unknownProvider: { ...validVibrioObservation, provider: "prototype-v99" },
} as const;

export const featureFieldAbsentFixture = {
	beachId: "gulfShores",
	displayName: "Gulf Shores",
};
