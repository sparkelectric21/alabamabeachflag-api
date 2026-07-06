

import type { WaterTemperatureObservation } from "./client";
import { fetchWithRetry } from "../../utils/http";

const NDBC_BASE_URL = "https://www.ndbc.noaa.gov/data/realtime2";

function parseNDBCTimestamp(headers: string[], values: string[]): string {
	const valueFor = (...names: string[]): string | undefined => {
		const index = names.map((name) => headers.indexOf(name)).find((index) => index >= 0);
		return index === undefined ? undefined : values[index];
	};
	const yearText = valueFor("#YY", "YY", "YYYY");
	const month = Number(valueFor("MM"));
	const day = Number(valueFor("DD"));
	const hour = Number(valueFor("hh"));
	const minute = Number(valueFor("mm") ?? "0");
	const year = Number(yearText);

	if (
		!yearText ||
		[year, month, day, hour, minute].some(Number.isNaN) ||
		year < 2000 ||
		year > 2100 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		hour < 0 ||
		hour > 23 ||
		minute < 0 ||
		minute > 59
	) {
		throw new Error("NDBC observation timestamp is invalid");
	}

	return new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString();
}

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

	if (!Number.isFinite(waterTempC) || waterTempC < -5 || waterTempC > 45) {
		throw new Error(`Invalid water temperature for station ${stationId}`);
	}

	const waterTempF = Math.round((waterTempC * 9) / 5 + 32);

	return {
		temperature: waterTempF,
		temperatureUnit: "F",
		observedAt: parseNDBCTimestamp(headers, values),
	};
}
