

import { beaches } from "../../config/BeachRegistry";
import { fetchLatestWaterTemperature } from "./service";
import { elapsedMs, logError, logInfo } from "../../utils/logger";

export interface WaterTemperatureResults {
	[beachId: string]: {
		temperature: number;
		temperatureUnit: "F";
		observedAt: string;
		provider: "coops" | "ndbc";
		stationId: string;
	};
}

export async function refreshWaterTemperatures(): Promise<WaterTemperatureResults> {
	const startedAt = Date.now();
	logInfo("Water Temperature", "Starting refresh");
	const results: WaterTemperatureResults = {};

	for (const beach of beaches) {
		if (!beach.supports.waterTemperature || !beach.waterTemperature) {
			continue;
		}

		try {
			const observation = await fetchLatestWaterTemperature(
				beach.waterTemperature,
			);

			results[beach.id] = observation;
		} catch (error) {
			logError("Water Temperature", `${beach.displayName} failed`, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	logInfo("Water Temperature", "Finished refresh", {
		durationMs: elapsedMs(startedAt),
		count: Object.keys(results).length,
	});
	return results;
}