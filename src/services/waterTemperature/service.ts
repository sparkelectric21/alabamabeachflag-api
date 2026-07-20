import type { BeachDefinition } from "../../config/BeachRegistry";
import {
	fetchWaterTemperature,
	type WaterTemperatureObservation,
} from "./client";
import { fetchNDBCWaterTemperature } from "./ndbcClient";
import {
	DIRECT_OBSERVATION_MAX_AGE_MS,
	directObservationAgeMs,
	isFreshDirectObservation,
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
	if (source.provider === "ndbc") return "ndbc_provider_failure";
	return "coops_provider_failure";
}

export async function fetchLatestWaterTemperature(
	sourceConfig: BeachDefinition["waterTemperature"],
	requestCache: Map<string, Promise<WaterTemperatureObservationWithSource>> = new Map(),
	options: WaterTemperatureSelectionOptions = {},
): Promise<WaterTemperatureObservationWithSource> {
	if (!sourceConfig || sourceConfig.sources.length === 0) {
		throw new Error("Water temperature source is not configured.");
	}

	const failures: string[] = [];
	const staleCandidates: WaterTemperatureObservationWithSource[] = [];
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

			if (isFreshDirectObservation(observation.observedAt, now)) {
				if (staleCandidates.length > 0) {
					logInfo("Water Temperature", "Skipped stale candidate for fresh fallback", {
						staleCandidates: staleCandidates.map((candidate) => `${candidate.provider}:${candidate.stationId}`).join(","),
						selectedProvider: observation.provider,
						selectedStationId: observation.stationId,
						selectedAgeMinutes: Math.round((directObservationAgeMs(observation.observedAt, now) ?? 0) / 60_000),
					});
				}
				return observation;
			}

			const ageMs = directObservationAgeMs(observation.observedAt, now);
			if (ageMs !== undefined && ageMs > DIRECT_OBSERVATION_MAX_AGE_MS) {
				staleCandidates.push(observation);
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

	throw new Error(
		`No approved fresh water temperature source is available. stale=${staleCandidates.length}; failed=${failures.length}`,
	);
}
