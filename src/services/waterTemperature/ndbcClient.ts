

import type { WaterTemperatureObservation } from "./client";
import { fetchWithRetry } from "../../utils/http";

const NDBC_BASE_URL = "https://www.ndbc.noaa.gov/data/realtime2";

export async function fetchNDBCWaterTemperature(
	stationId: string,
): Promise<WaterTemperatureObservation> {
	const response = await fetchWithRetry(
		`${NDBC_BASE_URL}/${stationId}.txt`,
		{
			headers: {
				"User-Agent": "Alabama Beach Flag",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`Failed to fetch NDBC station ${stationId} (${response.status})`,
		);
	}

	const text = await response.text();
	const lines = text.trim().split("\n");

	if (lines.length < 3) {
		throw new Error(`Unexpected NDBC response for station ${stationId}`);
	}

	const headers = lines[0].trim().split(/\s+/);
	const values = lines[2].trim().split(/\s+/);

	const wtIndex = headers.indexOf("WTMP");

	if (wtIndex === -1) {
		throw new Error(`WTMP column not found for station ${stationId}`);
	}

	const waterTempC = Number(values[wtIndex]);

	if (Number.isNaN(waterTempC)) {
		throw new Error(`Invalid water temperature for station ${stationId}`);
	}

	const waterTempF = Math.round((waterTempC * 9) / 5 + 32);

	return {
		temperature: waterTempF,
		temperatureUnit: "F",
		observedAt: new Date().toISOString(),
	};
}