import type { BeachDefinition } from "../../config/BeachRegistry";
import {
	fetchWaterTemperature,
	type WaterTemperatureObservation,
} from "./client";
import { fetchNDBCWaterTemperature } from "./ndbcClient";
import {
	classifyDirectObservation,
	directObservationAgeMs,
	DIRECT_OBSERVATION_MAX_AGE_MS,
	DIRECT_OBSERVATION_UNAVAILABLE_AFTER_MS,
} from "./freshness";
import { logInfo, logWarn } from "../../utils/logger";

type WaterTemperatureSource = NonNullable<
	BeachDefinition["waterTemperature"]
>["sources"][number];

export interface WaterTemperatureObservationWithSource
	extends WaterTemperatureObservation {
	provider: WaterTemperatureSource["provider"];
	stationId: string;
}

export interface ClassifiedWaterTemperatureObservation extends WaterTemperatureObservationWithSource {
	freshnessStatus: "current" | "stale";
	ageMinutes: number;
	staleAfterMinutes: number;
	unavailableAfterMinutes: number;
}

async function fetchFromSource(
	source: WaterTemperatureSource,
): Promise<WaterTemperatureObservationWithSource> {
	const observation =
		source.provider === "coops"
			? await fetchWaterTemperature(source.stationId)
			: await fetchNDBCWaterTemperature(source.stationId);

	return {
		...observation,
		provider: source.provider,
		stationId: source.stationId,
	};
}

function withFreshness(
	observation: WaterTemperatureObservationWithSource,
	now: Date,
	freshnessStatus: "current" | "stale",
): ClassifiedWaterTemperatureObservation {
	return {
		...observation,
		freshnessStatus,
		ageMinutes: Math.max(0, Math.round((directObservationAgeMs(observation.observedAt, now) ?? 0) / 60_000)),
		staleAfterMinutes: DIRECT_OBSERVATION_MAX_AGE_MS / 60_000,
		unavailableAfterMinutes: DIRECT_OBSERVATION_UNAVAILABLE_AFTER_MS / 60_000,
	};
}

function freshnessLogFields(observation: ClassifiedWaterTemperatureObservation) {
	return {
		provider: observation.provider,
		stationId: observation.stationId,
		observedAt: observation.observedAt,
		ageMinutes: observation.ageMinutes,
		staleAfterMinutes: observation.staleAfterMinutes,
		unavailableAfterMinutes: observation.unavailableAfterMinutes,
	};
}

export interface WaterTemperatureSelectionOptions {
	now?: Date;
	loadSource?: (source: WaterTemperatureSource) => Promise<WaterTemperatureObservationWithSource>;
	beachId?: string;
	diagnosticScope?: "general_temperature" | "vibrio_conditions";
}

function providerFailureCondition(source: WaterTemperatureSource, error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (/timed out/i.test(message)) return `${source.provider}_timeout`;
	if (/(?:\bHTTP\s*|\bstatus\s*|\()\d{3}\b/i.test(message)) return `${source.provider}_http_failure`;
	if (source.provider === "ndbc" && /WTMP column not found/i.test(message)) return "ndbc_missing_water_temperature";
	if (source.provider === "ndbc" && /observation timestamp is invalid/i.test(message)) return "ndbc_invalid_timestamp";
	if (source.provider === "ndbc" && /Invalid water temperature/i.test(message)) return "ndbc_invalid_water_temperature";
	if (source.provider === "ndbc" && /Unexpected NDBC response/i.test(message)) return "ndbc_malformed_response";
	if (/parse failure|malformed response|unexpected response/i.test(message)) return `${source.provider}_parser_failure`;
	if (/No water temperature available/i.test(message)) return `${source.provider}_missing_water_temperature`;
	if (/invalid water temperature/i.test(message)) return `${source.provider}_invalid_water_temperature`;
	if (/invalid timestamp|Invalid time value/i.test(message)) return `${source.provider}_invalid_timestamp`;
	if (source.provider === "ndbc") return "ndbc_provider_failure";
	return "coops_provider_failure";
}

export async function fetchLatestWaterTemperature(
	sourceConfig: BeachDefinition["waterTemperature"],
	requestCache: Map<string, Promise<WaterTemperatureObservationWithSource>> = new Map(),
	options: WaterTemperatureSelectionOptions = {},
): Promise<ClassifiedWaterTemperatureObservation> {
	if (!sourceConfig || sourceConfig.sources.length === 0) {
		throw new Error("Water temperature source is not configured.");
	}

	const failures: string[] = [];
	const staleCandidates: ClassifiedWaterTemperatureObservation[] = [];
	const now = options.now ?? new Date();

	for (const source of sourceConfig.sources) {
		try {
			const cacheKey = `${source.provider}:${source.stationId}`;
			let request = requestCache.get(cacheKey);

			if (!request) {
				request = options.loadSource ? options.loadSource(source) : fetchFromSource(source);
				requestCache.set(cacheKey, request);
			}

			const observation = await request;
			const freshness = classifyDirectObservation(observation.observedAt, now);

			if (freshness === "current") {
				const selected = withFreshness(observation, now, "current");
				if (staleCandidates.length > 0) {
					logInfo("Water Temperature", "Skipped stale candidate for fresh fallback", {
						staleCandidates: staleCandidates.map((candidate) => `${candidate.provider}:${candidate.stationId}`).join(","),
						selectedProvider: observation.provider,
						selectedStationId: observation.stationId,
						selectedAgeMinutes: selected.ageMinutes,
					});
				}
				logInfo("Water Temperature", "Current observation accepted", freshnessLogFields(selected));
				return selected;
			}

			if (freshness === "stale") {
				staleCandidates.push(withFreshness(observation, now, "stale"));
			} else if (freshness === "unavailable") {
				const rejected = withFreshness(observation, now, "stale");
				logWarn("Water Temperature", "Observation rejected beyond hard cutoff", freshnessLogFields(rejected));
			} else {
				logWarn("Water Temperature", "Approved source candidate failed", {
					condition: "invalid_timestamp",
					provider: source.provider,
					stationId: source.stationId,
				});
			}
		} catch (error) {
			logWarn("Water Temperature", "Approved source candidate failed", {
				beachId: options.beachId,
				scope: options.diagnosticScope,
				condition: providerFailureCondition(source, error),
				provider: source.provider,
				stationId: source.stationId,
			});
			failures.push(
				`${source.provider}:${source.stationId} - ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	if (options.diagnosticScope !== "vibrio_conditions" && staleCandidates.length > 0) {
		const selected = staleCandidates[0];
		logWarn("Water Temperature", "Stale observation accepted", freshnessLogFields(selected));
		return selected;
	}

	throw new Error(
		`No approved usable water temperature source is available. stale=${staleCandidates.length}; failed=${failures.length}`,
	);
}
