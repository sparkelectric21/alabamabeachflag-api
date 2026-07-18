

import { beaches } from "../../config/BeachRegistry";
import { fetchLatestWaterTemperature } from "./service";
import { elapsedMs, logError, logInfo, logWarn } from "../../utils/logger";
import type { WaterTemperatureObservationWithSource } from "./service";

export interface WaterTemperatureResults {
	[beachId: string]: {
		temperature: number;
		temperatureUnit: "F";
		observedAt: string;
		provider: "coops" | "ndbc";
		stationId: string;
	};
}

export interface WaterTemperatureSelections {
	general: WaterTemperatureResults;
	vibrio: WaterTemperatureResults;
}

async function refreshConfiguredWaterTemperatures(
	requestCache: Map<string, Promise<WaterTemperatureObservationWithSource>>,
	scope: "general_temperature" | "vibrio_conditions",
): Promise<WaterTemperatureResults> {
	const results: WaterTemperatureResults = {};

	for (const beach of beaches) {
		const sourceConfig = scope === "general_temperature"
			? (beach.supports.waterTemperature ? beach.waterTemperature : undefined)
			: (beach.vibrioConditions.eligible ? beach.vibrioConditions.waterTemperature : undefined);

		if (scope === "vibrio_conditions" && !beach.vibrioConditions.eligible) {
			logInfo("Vibrio Conditions", "Beach excluded by coverage policy", {
				beachId: beach.id,
				condition: "beach_excluded_by_coverage_policy",
			});
			continue;
		}
		if (!sourceConfig || sourceConfig.sources.length === 0) {
			if (scope === "vibrio_conditions") {
				logWarn("Vibrio Conditions", "No approved station configured", {
					beachId: beach.id,
					condition: "no_approved_station",
				});
			}
			continue;
		}

		try {
			results[beach.id] = await fetchLatestWaterTemperature(sourceConfig, requestCache, {
				beachId: beach.id,
				diagnosticScope: scope,
			});
		} catch (error) {
			logError(scope === "vibrio_conditions" ? "Vibrio Conditions" : "Water Temperature", `${beach.displayName} failed`, {
				condition: scope === "vibrio_conditions" ? "no_approved_observation" : undefined,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return results;
}

export async function refreshWaterTemperatureSelections(): Promise<WaterTemperatureSelections> {
	const startedAt = Date.now();
	logInfo("Water Temperature", "Starting refresh");
	const requestCache = new Map<string, Promise<WaterTemperatureObservationWithSource>>();
	const general = await refreshConfiguredWaterTemperatures(requestCache, "general_temperature");
	const vibrio = await refreshConfiguredWaterTemperatures(requestCache, "vibrio_conditions");

	logInfo("Water Temperature", "Finished refresh", {
		durationMs: elapsedMs(startedAt),
		generalCount: Object.keys(general).length,
		vibrioCount: Object.keys(vibrio).length,
	});
	return { general, vibrio };
}

export async function refreshWaterTemperatures(): Promise<WaterTemperatureResults> {
	const requestCache = new Map<string, Promise<WaterTemperatureObservationWithSource>>();
	return refreshConfiguredWaterTemperatures(requestCache, "general_temperature");
}
