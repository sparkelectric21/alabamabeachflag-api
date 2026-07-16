import { normalizeWeatherCondition } from "../weather/normalizeWeatherCondition";
import { beaches as BEACH_REGISTRY } from "../../config/BeachRegistry";
import { fetchForecast, fetchPoint } from "../nws/client";
import { refreshWaterTemperatures } from "../waterTemperature/refresh";
import type { WaterTemperatureResults } from "../waterTemperature/refresh";
import { getBeachForecasts } from "../beachForecast/service";
import { fetchCurrentUV } from "../beachForecast/openMeteoClient";
import { elapsedMs, logError, logInfo } from "../../utils/logger";
import type { BeachForecast } from "../../models/BeachConditions";
import type { NWSForecastResponse } from "../nws/client";
import { API_VERSION } from "../../config/version";

async function safeFetchCurrentUV(
	latitude: number,
	longitude: number,
): Promise<number | undefined> {
	try {
		const value = await fetchCurrentUV(latitude, longitude);
		return value == null ? undefined : Math.round(value);
	} catch (error) {
		logError("Beach Conditions", "Open-Meteo UV failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function getUVCategory(uv: number | undefined): string | undefined {
	if (uv === undefined) {
		return undefined;
	}

	if (uv < 3) {
		return "Low";
	}

	if (uv < 6) {
		return "Moderate";
	}

	if (uv < 8) {
		return "High";
	}

	if (uv < 11) {
		return "Very High";
	}

	return "Extreme";
}

async function safeGetBeachForecasts(): Promise<Map<string, BeachForecast>> {
	try {
		return await getBeachForecasts();
	} catch (error) {
		logError("Beach Conditions", "NOAA beach forecast failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return new Map();
	}
}

async function mapWithConcurrency<T, R>(
	values: T[],
	limit: number,
	mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < values.length) {
			const index = nextIndex++;
			results[index] = await mapper(values[index], index);
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(limit, values.length) }, () => worker()),
	);
	return results;
}

export async function buildBeachConditionsPayload() {
	const startedAt = Date.now();
	logInfo("Beach Conditions", "Starting refresh");

	const [orangeBeachUV, fortMorganUV, dauphinIslandUV] = await Promise.all([
		safeFetchCurrentUV(30.248108, -87.71726),
		safeFetchCurrentUV(30.2285, -88.0243),
		safeFetchCurrentUV(30.2506, -88.1096),
	]);
	const regionalUV = {
		orangeBeach: orangeBeachUV,
		fortMorgan: fortMorganUV,
		dauphinIsland: dauphinIslandUV,
	};

	logInfo("Beach Conditions", "Regional UV refreshed", {
		orangeBeach: regionalUV.orangeBeach,
		fortMorgan: regionalUV.fortMorgan,
		dauphinIsland: regionalUV.dauphinIsland,
	});

	const beachConditions: Array<{
		beachId: string;
		displayName: string;
		temperature: number;
		temperatureUnit: string;
		condition: string | undefined;
		windSpeed: string;
		windDirection: string;
		waterTemperature: WaterTemperatureResults[string] | null;
		forecast: BeachForecast | null;
	}> = [];
	const errors: Array<{
		beachId: string;
		displayName: string;
		message: string;
	}> = [];
	const [waterTemperatures, beachForecasts] = await Promise.all([
		refreshWaterTemperatures(),
		safeGetBeachForecasts(),
	]);
	const weatherRequests = new Map<string, Promise<NWSForecastResponse>>();

	await mapWithConcurrency(BEACH_REGISTRY, 4, async (beach, beachIndex) => {
		try {
			const weatherKey = `${beach.weather.latitude},${beach.weather.longitude}`;
			let weatherRequest = weatherRequests.get(weatherKey);

			if (!weatherRequest) {
				weatherRequest = fetchPoint(
					beach.weather.latitude,
					beach.weather.longitude,
				).then((point) => fetchForecast(point.properties.forecastHourly));
				weatherRequests.set(weatherKey, weatherRequest);
			}

			const forecast = await weatherRequest;
			const current = forecast.properties.periods[0];
			const beachForecast = beach.beachForecast
				? beachForecasts.get(beach.beachForecast.siteId)
				: undefined;

			const uvValue = beach.uv
				? regionalUV[beach.uv.region]
				: undefined;

			if (!current) {
				throw new Error("NWS hourly forecast did not include any periods.");
			}

			beachConditions[beachIndex] = {
				beachId: beach.id,
				displayName: beach.displayName,
				temperature: current.temperature,
				temperatureUnit: current.temperatureUnit,
				condition: normalizeWeatherCondition(current.shortForecast),
				windSpeed: current.windSpeed,
				windDirection: current.windDirection,
				waterTemperature: waterTemperatures[beach.id] ?? null,
				forecast: beach.beachForecast
					? {
						...(beachForecast ?? {}),
						uvValue,
						uvCategory: getUVCategory(uvValue),
					}
					: null,
			};
		} catch (error) {
			logError("Beach Conditions", `${beach.displayName} failed`, {
				error: error instanceof Error ? error.message : String(error),
			});

			errors.push({
				beachId: beach.id,
				displayName: beach.displayName,
					message: "provider_unavailable",
			});
		}
	});
	const successfulBeachConditions = beachConditions.filter(Boolean);

	const payload = {
		status: successfulBeachConditions.length > 0 ? "ok" : "unavailable",
		apiVersion: API_VERSION,
		source: "NOAA",
		generatedAt: new Date().toISOString(),
		count: successfulBeachConditions.length,
		beachConditions: successfulBeachConditions,
		errors,
	};

	logInfo("Beach Conditions", "Finished refresh", {
		durationMs: elapsedMs(startedAt),
		count: successfulBeachConditions.length,
		errors: errors.length,
	});

	return payload;
}
