

import { beaches } from "../../config/BeachRegistry";
import { fetchLatestWaterTemperature } from "./service";

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
			console.error(
				`[Water Temperature] ${beach.displayName}:`,
				error,
			);
		}
	}

	return results;
}