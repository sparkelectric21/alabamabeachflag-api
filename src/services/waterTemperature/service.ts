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
	let firstValidObservation: WaterTemperatureObservationWithSource | undefined;
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
			firstValidObservation ??= observation;

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
			failures.push(
				`${source.provider}:${source.stationId} - ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	// Preserve the general water-temperature tile's existing behavior. Vibrio
	// independently rejects this observation when every approved source is stale.
	if (firstValidObservation) {
		logWarn("Water Temperature", "No approved fresh candidate; preserving general-temperature fallback", {
			selectedProvider: firstValidObservation.provider,
			selectedStationId: firstValidObservation.stationId,
			selectedAgeMinutes: Math.round((directObservationAgeMs(firstValidObservation.observedAt, now) ?? 0) / 60_000),
			staleCandidates: staleCandidates.length,
			failedCandidates: failures.length,
		});
		return firstValidObservation;
	}

	throw new Error(
		`No water temperature sources returned valid data. ${failures.join("; ")}`,
	);
}
