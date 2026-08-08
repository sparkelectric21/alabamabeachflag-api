import type { RefreshJob } from "../services/refresh/types";
import type { HistoricalObservationInput } from "./types";

type Payload = Record<string, any>;

function value(input: Omit<HistoricalObservationInput, "fetchedAt">, fetchedAt: string): HistoricalObservationInput {
	return { ...input, fetchedAt };
}

export function extractHistoricalObservations(job: RefreshJob, payload: Payload): HistoricalObservationInput[] {
	const fetchedAt = payload.generatedAt;
	if (typeof fetchedAt !== "string") return [];
	const observations: HistoricalObservationInput[] = [];

	if (job === "beach-conditions") {
		for (const beach of payload.beachConditions ?? []) {
			const water = beach.waterTemperature;
			if (water?.observedAt && Number.isFinite(water.temperature)) observations.push(value({
				observationType: "water_temperature", recordKind: "observation", beachId: beach.beachId,
				provider: water.provider, stationId: water.stationId, observedAt: water.observedAt,
				valueNumeric: water.temperature, unit: water.temperatureUnit ?? "F",
				freshnessState: water.freshnessStatus,
				providerMetadata: {
					ageMinutes: water.ageMinutes, staleAfterMinutes: water.staleAfterMinutes,
					unavailableAfterMinutes: water.unavailableAfterMinutes,
				},
			}, fetchedAt));

			const tide = beach.tide;
			for (const event of tide?.events ?? []) if (event?.time && Number.isFinite(event.height)) observations.push(value({
				observationType: `tide_${event.type}`, recordKind: "prediction", beachId: beach.beachId,
				provider: "noaa_coops", stationId: tide.stationId, observedAt: event.time,
				valueNumeric: event.height, unit: tide.units, sourceIdentifier: tide.stationUrl,
				providerMetadata: { datum: tide.datum, stationType: tide.stationType, curveMethod: tide.curveMethod },
			}, tide.fetchedAt ?? fetchedAt));
		}
	}

	if (job === "water-quality") {
		for (const sample of payload.waterQuality ?? []) {
			if (!sample.sampleDate) continue;
			const observedAt = `${sample.sampleDate}T00:00:00.000Z`;
			if (Number.isFinite(sample.enterococcus)) observations.push(value({
				observationType: "water_quality_enterococcus", recordKind: "result", beachId: sample.beachId,
				provider: "adem", stationId: sample.beachId, observedAt, valueNumeric: sample.enterococcus,
				unit: "CFU/100mL", qualityFlag: sample.status, sourceIdentifier: sample.reportUrl,
				providerMetadata: { advisory: sample.advisory, timestampPrecision: "date" },
			}, fetchedAt));
			observations.push(value({
				observationType: "water_quality_advisory", recordKind: "state", beachId: sample.beachId,
				provider: "adem", stationId: sample.beachId, observedAt,
				valueText: sample.advisory ? "active" : "inactive", qualityFlag: sample.status,
				sourceIdentifier: sample.reportUrl, providerMetadata: { timestampPrecision: "date" },
			}, fetchedAt));
		}
	}

	if (job === "beach-flags") {
		for (const report of payload.beachFlags ?? []) {
			if (!report.lastUpdated || !report.primaryFlag) continue;
			const fetchedTime = new Date(report.lastUpdated);
			if (!Number.isFinite(fetchedTime.getTime())) continue;
			// Municipal pages expose current state but no immutable effective time.
			// Use an hourly UTC snapshot key so five-minute refreshes do not create noise,
			// while state changes inside the hour remain preserved as revisions.
			fetchedTime.setUTCMinutes(0, 0, 0);
			observations.push(value({
				observationType: "beach_flag", recordKind: "state", beachId: report.beachId,
				provider: report.sourceName, observedAt: fetchedTime.toISOString(),
				valueText: report.primaryFlag, qualityFlag: report.sourceType,
				providerMetadata: { hasPurpleFlag: report.hasPurpleFlag, timestampMeaning: "fetched_at_when_source_has_no_effective_time" },
			}, fetchedAt));
		}
	}

	return observations;
}
